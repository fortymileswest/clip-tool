// Fade curves shared by the Node processor, the editor preview, and the
// waveform overlay — one implementation so all three always agree.
export type FadeType = 'linear' | 'exp' | 'log' | 's';

export interface FadeSpec {
  /** Fade length in seconds. 0 disables the fade. */
  len: number;
  type: FadeType;
  /** Curve bend from -1 (bulges up / faster) to +1 (bulges down / slower). */
  bend: number;
}

/** Gain for fade-in progress p in [0,1]. Fade-outs mirror: fadeGain(1 - p). */
export function fadeGain(p: number, type: FadeType, bend: number): number {
  p = Math.max(0, Math.min(1, p));
  let g: number;
  switch (type) {
    case 'exp': g = p * p; break;
    case 'log': g = Math.sqrt(p); break;
    case 's': g = p * p * (3 - 2 * p); break;
    default: g = p;
  }
  if (bend > 0) g = Math.pow(g, 1 + 3 * bend);
  else if (bend < 0) g = 1 - Math.pow(1 - g, 1 + 3 * -bend);
  return g;
}

/** Apply fade-in/out envelopes in place at the start/end of the audio. */
export function applyFades(
  channels: Float32Array[],
  sampleRate: number,
  fadeIn?: FadeSpec | null,
  fadeOut?: FadeSpec | null,
): void {
  if (channels.length === 0) return;
  const total = channels[0]!.length;

  if (fadeIn && fadeIn.len > 0) {
    const n = Math.min(total, Math.round(fadeIn.len * sampleRate));
    for (let i = 0; i < n; i++) {
      const g = fadeGain(i / n, fadeIn.type, fadeIn.bend);
      for (const ch of channels) ch[i]! *= g;
    }
  }

  if (fadeOut && fadeOut.len > 0) {
    const n = Math.min(total, Math.round(fadeOut.len * sampleRate));
    const start = total - n;
    for (let i = 0; i < n; i++) {
      const g = fadeGain(1 - (i + 1) / n, fadeOut.type, fadeOut.bend);
      for (const ch of channels) ch[start + i]! *= g;
    }
  }
}
