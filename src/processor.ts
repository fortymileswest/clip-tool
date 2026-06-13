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
    | 'pitchSemitones' | 'stretchWindowMs' | 'stretchTransient'
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
  if (hasStretch || hasPitch) {
    return stretchCyclic(out, opts.stretchRatio || 1, sampleRate, opts.stretchCyclic ?? false, {
      pitch: opts.pitchSemitones || 0,
      windowMs: opts.stretchWindowMs,
      transient: opts.stretchTransient,
    });
  }

  return out;
}

export async function processAudio(opts: ProcessOptions): Promise<void> {
  const decoded = await decodeWav(opts.inputPath);
  const channels: Float32Array[] = [];
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    channels.push(decoded.getChannelData(c));
  }
  const processed = processSamples(channels, decoded.sampleRate, opts);
  await encodeWavFile(opts.outputPath, processed, decoded.sampleRate);
}
