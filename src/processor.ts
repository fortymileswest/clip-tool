import { decodeWav } from './wavDecoder.js';
import { encodeWavFile } from './wavEncoder.js';
import { stretchCyclic } from './timestretch.js';
import { applyFades } from './fades.js';
import type { FadeSpec } from './fades.js';

export type ChannelMode = 'left' | 'right' | 'mixed' | 'stereo' | 'side';

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

// Highest sample magnitude that survives the guard. Just below 1.0 so the
// written float never rounds up to a clipping value on import.
const PEAK_CEILING = 0.9999;

// Scale all channels by one global factor if any sample exceeds the ceiling.
// Global (not per-channel) so stereo/inter-channel balance is preserved.
function preventClipping(channels: Float32Array[]): void {
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]!);
      if (a > peak) peak = a;
    }
  }
  if (peak > PEAK_CEILING) {
    const g = PEAK_CEILING / peak;
    for (const ch of channels) {
      for (let i = 0; i < ch.length; i++) ch[i]! *= g;
    }
  }
}

// Pure sample-domain processing: trim, channel mix, gain. Kept separate from
// file I/O so it is unit-testable on synthetic buffers.
export function processSamples(
  channels: Float32Array[],
  sampleRate: number,
  opts: Pick<
    ProcessOptions,
    | 'gain_dB' | 'channel' | 'crop' | 'trimStart' | 'trimEnd'
    | 'stretchRatio' | 'stretchCyclic' | 'fadeIn' | 'fadeOut' | 'removeDc'
    | 'pitchSemitones' | 'stretchWindowMs' | 'stretchTransient' | 'preventClipping'
  >,
): Float32Array[] {
  if (channels.length === 0) throw new Error('processSamples: no channels');
  let frameCount = channels[0]!.length;

  let startFrame = 0;
  let endFrame = frameCount;
  if (opts.crop) {
    if (opts.trimStart < 0) {
      throw new Error(`trimStart must be >= 0, got ${opts.trimStart}`);
    }
    if (opts.trimStart >= opts.trimEnd) {
      throw new Error(`trimStart (${opts.trimStart}) must be less than trimEnd (${opts.trimEnd})`);
    }
    startFrame = Math.min(Math.round(opts.trimStart * sampleRate), frameCount);
    endFrame = Math.min(Math.round(opts.trimEnd * sampleRate), frameCount);
  }
  frameCount = endFrame - startFrame;

  const trimmed = channels.map((ch) => ch.subarray(startFrame, endFrame));
  const left = trimmed[0]!;
  const right = trimmed[1] ?? trimmed[0]!; // mono input: treat both channels as c0

  let out: Float32Array[];
  switch (opts.channel) {
    case 'left':
      out = [Float32Array.from(left)];
      break;
    case 'right':
      out = [Float32Array.from(right)];
      break;
    case 'mixed': {
      const mono = new Float32Array(frameCount);
      for (let i = 0; i < frameCount; i++) mono[i] = 0.5 * left[i]! + 0.5 * right[i]!;
      out = [mono];
      break;
    }
    case 'side': {
      const mono = new Float32Array(frameCount);
      for (let i = 0; i < frameCount; i++) mono[i] = 0.5 * left[i]! - 0.5 * right[i]!;
      out = [mono];
      break;
    }
    case 'stereo':
      out = trimmed.map((ch) => Float32Array.from(ch));
      break;
  }

  // Remove DC offset: subtract each channel's mean. Done before gain so the
  // gain stage operates on the centred signal.
  if (opts.removeDc) {
    for (const ch of out) {
      if (ch.length === 0) continue;
      let sum = 0;
      for (let i = 0; i < ch.length; i++) sum += ch[i]!;
      const mean = sum / ch.length;
      if (mean !== 0) {
        for (let i = 0; i < ch.length; i++) ch[i]! -= mean;
      }
    }
  }

  if (opts.gain_dB !== 0) {
    const factor = Math.pow(10, opts.gain_dB / 20);
    for (const ch of out) {
      for (let i = 0; i < ch.length; i++) ch[i]! *= factor;
    }
  }

  // Fades run before the stretch so they scale with it — matching the
  // preview, which stretches already-faded audio.
  applyFades(out, sampleRate, opts.fadeIn, opts.fadeOut);

  const hasStretch = !!opts.stretchRatio && Math.abs(opts.stretchRatio - 1) > 1e-3;
  const hasPitch = !!opts.pitchSemitones && Math.abs(opts.pitchSemitones) > 1e-6;

  // The stretch/pitch pass is applied downstream by processAudio, so its long,
  // CPU-heavy loop can report progress and yield to the event loop (otherwise the
  // host progress bar freezes for the whole stretch). The clip guard must run
  // after that overshoot, so when a stretch is pending we defer it too; with no
  // stretch we apply it here, keeping the pure synchronous path (and its tests).
  if (!hasStretch && !hasPitch && opts.preventClipping) preventClipping(out);

  return out;
}

export async function processAudio(opts: ProcessOptions, onProgress?: (progress: number) => void): Promise<void> {
  const hasStretch = !!opts.stretchRatio && Math.abs(opts.stretchRatio - 1) > 1e-3;
  const hasPitch = !!opts.pitchSemitones && Math.abs(opts.pitchSemitones) > 1e-6;
  const willStretch = hasStretch || hasPitch;

  // Progress budget across the three CPU stages. Decode -> [0, decodeEnd],
  // stretch -> [decodeEnd, stretchEnd], encode -> [stretchEnd, 1]. The stretch
  // (when present) is the slowest, so it takes the wide middle band; otherwise
  // decode/encode split the bar. Reporting also yields to the event loop on each
  // tick (the host dialog can then repaint) — the pipeline is otherwise
  // uninterrupted synchronous work that leaves the bar frozen until the end.
  const decodeEnd = willStretch ? 0.15 : 0.5;
  const stretchEnd = willStretch ? 0.85 : decodeEnd;
  const stage = onProgress
    ? (lo: number, hi: number) => async (frac: number): Promise<void> => {
        const clamped = frac < 0 ? 0 : frac > 1 ? 1 : frac;
        onProgress(lo + (hi - lo) * clamped);
        await new Promise<void>((resolve) => setTimeout(resolve));
      }
    : () => undefined;

  const decoded = await decodeWav(opts.inputPath, stage(0, decodeEnd));
  const channels: Float32Array[] = [];
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    channels.push(decoded.getChannelData(c));
  }

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

  await encodeWavFile(opts.outputPath, processed, decoded.sampleRate, stage(stretchEnd, 1));
}
