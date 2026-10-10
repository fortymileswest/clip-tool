// Pure sample-domain processing shared by the Node processor and (compiled to
// the Dsp global) the editor preview, so what you hear is what gets rendered.
// No file I/O here: that stays in processor.ts.
import { applyFades } from './fades.js';
import type { FadeSpec } from './fades.js';

export type ChannelMode = 'left' | 'right' | 'mixed' | 'stereo' | 'side';

export interface SampleOptions {
  gain_dB: number;
  channel: ChannelMode;
  crop: boolean;
  /** Seconds into the input. */
  trimStart: number;
  trimEnd: number;
  /** Output length / input length; 1 (or absent) = no stretch. Pitch is preserved. */
  stretchRatio?: number;
  /** Pitch shift in semitones (-24..+24); length preserved. */
  pitchSemitones?: number;
  /** Fade-in applied at the output start. */
  fadeIn?: FadeSpec | null;
  /** Fade-out applied at the output end. */
  fadeOut?: FadeSpec | null;
  /** Subtract each channel's mean (remove DC offset) before gain/fades. */
  removeDc?: boolean;
  /** See ProcessOptions.preventClipping. */
  preventClipping?: boolean;
}

/** Below this a ratio counts as "no stretch", in the render and the preview. */
const NO_STRETCH_EPS = 1e-6;

export function hasStretch(ratio: number | undefined): boolean {
  return !!ratio && Math.abs(ratio - 1) > NO_STRETCH_EPS;
}

export function hasPitch(semitones: number | undefined): boolean {
  return !!semitones && Math.abs(semitones) > 1e-6;
}

// Highest sample magnitude that survives the guard. Just below 1.0 so the
// written float never rounds up to a clipping value on import.
const PEAK_CEILING = 0.9999;

/** Scale all channels by one global factor if any sample exceeds the ceiling.
 *  Global (not per-channel) so stereo/inter-channel balance is preserved. */
export function preventClipping(channels: Float32Array[]): void {
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

/** Trim, channel mix, DC removal, gain and fades. The stretch/pitch pass and
 *  the clip guard that follows it run afterwards (see processor.ts). */
export function processSamples(
  channels: Float32Array[],
  sampleRate: number,
  opts: SampleOptions,
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
      out = [left.slice()];
      break;
    case 'right':
      out = [right.slice()];
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
      out = trimmed.map((ch) => ch.slice());
      break;
  }

  // Remove DC offset: subtract each channel's mean over the rendered range.
  // Done before gain so the gain stage operates on the centred signal.
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

  // Fades run before the stretch so they scale with it.
  applyFades(out, sampleRate, opts.fadeIn, opts.fadeOut);

  // With a stretch or pitch pending, the clip guard runs after it (it must
  // catch the stretch's overshoot); otherwise it runs here.
  if (!hasStretch(opts.stretchRatio) && !hasPitch(opts.pitchSemitones) && opts.preventClipping) {
    preventClipping(out);
  }

  return out;
}

/**
 * Min/max pairs for `count` blocks spanning the whole channel. Block edges are
 * fractional, so the peaks cover every sample and line up with the timeline
 * whatever the length (a fixed integer block size left the tail out).
 */
export function computePeaks(channels: Float32Array[], count: number): number[][] {
  return channels.map((ch) => {
    const n = ch.length;
    const peaks = new Array<number>(count * 2);
    for (let i = 0; i < count; i++) {
      const s = Math.floor((i * n) / count);
      const e = Math.max(s + 1, Math.floor(((i + 1) * n) / count));
      let mn = 0, mx = 0;
      for (let j = s; j < e && j < n; j++) {
        const v = ch[j]!;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      peaks[i * 2] = mn;
      peaks[i * 2 + 1] = mx;
    }
    return peaks;
  });
}
