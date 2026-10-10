import { decodeWav } from './wavDecoder.js';
import { encodeWavFile } from './wavEncoder.js';
import { stretchCyclic } from './timestretch.js';
import { clampStretchRatio } from './editRange.js';
import { hasPitch, hasStretch, preventClipping, processSamples } from './dsp.js';
import type { ChannelMode } from './dsp.js';
import type { FadeSpec } from './fades.js';

export { processSamples };
export type { ChannelMode };

export interface ProcessOptions {
  inputPath: string;
  outputPath: string;
  gain_dB: number;
  channel: ChannelMode;
  crop: boolean;
  trimStart: number;
  trimEnd: number;
  /** Output length / input length; 1 (or absent) = no stretch. Pitch is preserved. */
  stretchRatio?: number;
  /** Treat the audio as a cycle when stretching, keeping a loop seamless. */
  stretchCyclic?: boolean;
  /** Fade-in applied at the output start. */
  fadeIn?: FadeSpec | null;
  /** Fade-out applied at the output end. */
  fadeOut?: FadeSpec | null;
  /** Subtract each channel's mean (remove DC offset) before gain/fades. */
  removeDc?: boolean;
  /** Pitch shift in semitones (-24..+24); length preserved, cyclic-safe. */
  pitchSemitones?: number;
  /** Granular window in ms (small = metallic S950 character). */
  stretchWindowMs?: number;
  /** Transient preservation 0..1 for the granular stretch/pitch. */
  stretchTransient?: number;
  /**
   * Guard the output against clipping. When the final peak exceeds ±1.0 (e.g. a
   * pre-FX render captured hotter than the post-FX sound, or gain/stretch
   * overshoot), scale all channels down so the peak sits at the ceiling. Only
   * activates on overflow — sub-unity material is left bit-identical.
   */
  preventClipping?: boolean;
}

/** Thrown when processing stops because the caller's AbortSignal fired. */
export class ProcessCancelled extends Error {
  constructor() {
    super('Processing was cancelled.');
    this.name = 'ProcessCancelled';
  }
}

export async function processAudio(
  opts: ProcessOptions,
  onProgress?: (progress: number) => void,
  /** Cancels between progress ticks; processAudio then rejects with ProcessCancelled. */
  signal?: AbortSignal,
): Promise<void> {
  // The editor already clamps the ratio and shows it; clamp here too so no
  // caller can ask for an unbounded stretch.
  if (opts.stretchRatio !== undefined) {
    opts = { ...opts, stretchRatio: clampStretchRatio(opts.stretchRatio).ratio };
  }
  const willStretch = hasStretch(opts.stretchRatio) || hasPitch(opts.pitchSemitones);

  // Progress budget across the three CPU stages. Decode -> [0, decodeEnd],
  // stretch -> [decodeEnd, stretchEnd], encode -> [stretchEnd, 1]. The stretch
  // (when present) is the slowest, so it takes the wide middle band; otherwise
  // decode/encode split the bar. Reporting also yields to the event loop on each
  // tick (the host dialog can then repaint) — the pipeline is otherwise
  // uninterrupted synchronous work that leaves the bar frozen until the end.
  const decodeEnd = willStretch ? 0.15 : 0.5;
  const stretchEnd = willStretch ? 0.85 : decodeEnd;
  // Each tick is also where a cancel takes effect.
  const checkCancel = () => {
    if (signal?.aborted) throw new ProcessCancelled();
  };
  const stage = onProgress || signal
    ? (lo: number, hi: number) => async (frac: number): Promise<void> => {
        checkCancel();
        const clamped = frac < 0 ? 0 : frac > 1 ? 1 : frac;
        onProgress?.(lo + (hi - lo) * clamped);
        await new Promise<void>((resolve) => setTimeout(resolve));
        checkCancel();
      }
    : () => undefined;

  const decoded = await decodeWav(opts.inputPath, stage(0, decodeEnd));
  const channels: Float32Array[] = [];
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    channels.push(decoded.getChannelData(c));
  }

  checkCancel();
  let processed = processSamples(channels, decoded.sampleRate, opts);

  if (willStretch) {
    processed = await stretchCyclic(
      processed,
      opts.stretchRatio || 1,
      decoded.sampleRate,
      opts.stretchCyclic ?? false,
      {
        pitch: opts.pitchSemitones || 0,
        windowMs: opts.stretchWindowMs,
        transient: opts.stretchTransient,
        onProgress: stage(decodeEnd, stretchEnd),
      },
    );
    // The clip guard runs here (processSamples deferred it) so it catches the
    // stretch's overlap-add overshoot as well as any gain overshoot.
    if (opts.preventClipping) preventClipping(processed);
  }

  checkCancel();
  await encodeWavFile(opts.outputPath, processed, decoded.sampleRate, stage(stretchEnd, 1));
}
