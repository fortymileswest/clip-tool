// WSOLA (waveform-similarity overlap-add) time-stretch + pitch shift, shared by
// the Node processor and (compiled) the editor webview so preview and render
// agree.
//
// Pitch shift = granular stretch by the pitch factor, then resample back to the
// tempo length. Small windows + low transient preservation give the gritty,
// "metallic" granular character of an Akai S950-style time-stretch; large
// windows + high transient preservation stay clean.
export interface StretchOpts {
  /** Pitch shift in semitones (default 0). Length is preserved. */
  pitch?: number;
  /** Grain window in ms (default 50). Smaller = tighter/grainier, larger = smoother. */
  windowMs?: number;
  /** Transient preservation 0..1: snaps grains to onsets (ReaReaRea "transient-optimized"). */
  transient?: number;
  /** Lo-fi / Akai grit 0..1 (default 0 = clean). Bit reduction + gentle aliasing tame. */
  lofi?: number;
  /**
   * Progress 0..1 over the (dominant) WSOLA pass, awaited periodically so a long
   * stretch yields to the event loop and the host progress UI can repaint. The
   * webview preview passes none, so it stays synchronous.
   */
  onProgress?: (frac: number) => void | Promise<void>;
}

export async function stretchCyclic(
  channels: Float32Array[],
  ratio: number,
  sampleRate: number,
  cyclic: boolean,
  opts: StretchOpts = {},
): Promise<Float32Array[]> {
  if (channels.length === 0) return channels;
  const pitch = opts.pitch ?? 0;
  const pitchFactor = Math.pow(2, pitch / 12);
  const noStretch = Math.abs(ratio - 1) < 1e-6;
  const noPitch = Math.abs(pitchFactor - 1) < 1e-6;
  if (noStretch && noPitch) return channels.map((c) => Float32Array.from(c));

  const inLen = channels[0]!.length;
  const targetLen = Math.max(1, Math.round(inLen * ratio));

  // Stretch by ratio × pitchFactor, then (for pitch) resample down by
  // pitchFactor — net length = inLen × ratio, pitch × pitchFactor.
  const stretched = await wsola(channels, ratio * pitchFactor, sampleRate, cyclic, opts);
  // Resample for pitch with anti-aliasing on the downsample (pitch up), which
  // is what removes the folded-back "noisy" high end.
  const out = noPitch ? stretched : resample(stretched, targetLen, cyclic, sampleRate);

  // Optional lo-fi / Akai grit — off by default so the pitch shift stays clean
  // and musical (like a granular stretcher); dial in only when wanted.
  const lofi = Math.max(0, Math.min(1, opts.lofi ?? 0));
  if (lofi > 0) akaiColor(out, lofi, sampleRate);
  return out;
}

// Cascaded biquad (≈4th-order Butterworth) low-pass, applied in place.
function lowpass(channels: Float32Array[], fc: number, sampleRate: number): void {
  const w0 = (2 * Math.PI * fc) / sampleRate;
  const cs = Math.cos(w0);
  const sn = Math.sin(w0);
  // Two stages with the Butterworth 4th-order Q values for a flat passband.
  for (const q of [0.54119610, 1.30656296]) {
    const alpha = sn / (2 * q);
    const b0 = (1 - cs) / 2, b1 = 1 - cs, b2 = (1 - cs) / 2;
    const a0 = 1 + alpha, a1 = -2 * cs, a2 = 1 - alpha;
    const nb0 = b0 / a0, nb1 = b1 / a0, nb2 = b2 / a0, na1 = a1 / a0, na2 = a2 / a0;
    for (const ch of channels) {
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < ch.length; i++) {
        const x0 = ch[i]!;
        const y0 = nb0 * x0 + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
        x2 = x1; x1 = x0; y2 = y1; y1 = y0;
        ch[i] = y0;
      }
    }
  }
}

function akaiColor(channels: Float32Array[], metallic: number, sampleRate: number): void {
  // 12-bit (clean) down to ~8-bit (gritty) as metallic rises.
  const bits = 12 - 4 * metallic;
  const levels = Math.pow(2, bits);
  // One-pole low-pass, ~18kHz down to ~9kHz, to soften the harshest aliasing.
  const fc = 18000 - 9000 * metallic;
  const dt = 1 / sampleRate;
  const rc = 1 / (2 * Math.PI * fc);
  const a = dt / (rc + dt);
  for (const ch of channels) {
    if (ch.length === 0) continue;
    let y = ch[0]!;
    for (let i = 0; i < ch.length; i++) {
      const q = Math.round(ch[i]! * levels) / levels; // bit reduction
      y = y + a * (q - y); // gentle low-pass
      ch[i] = y;
    }
  }
}

// Catmull-Rom cubic resample to an exact output length. When downsampling
// (pitch up), an anti-aliasing low-pass is applied first so high frequencies
// don't fold back as noise — this is the main fix for "pitched up and noisy".
// When cyclic, indices wrap so a pitch-shifted loop stays seamless.
function resample(
  src: Float32Array[],
  targetLen: number,
  cyclic: boolean,
  sampleRate: number,
): Float32Array[] {
  const n = src[0]!.length;
  if (n === 0 || targetLen <= 0) return src.map(() => new Float32Array(Math.max(0, targetLen)));
  const step = n / targetLen;
  if (step > 1.0001) {
    // Reading faster than 1×: band-limit to the new Nyquist before decimating.
    lowpass(src, (sampleRate / 2) / step * 0.9, sampleRate);
  }
  const idx = cyclic
    ? (i: number) => ((i % n) + n) % n
    : (i: number) => (i < 0 ? 0 : i >= n ? n - 1 : i);
  return src.map((ch) => {
    const out = new Float32Array(targetLen);
    for (let i = 0; i < targetLen; i++) {
      const pos = i * step;
      const i1 = Math.floor(pos);
      const t = pos - i1;
      const p0 = ch[idx(i1 - 1)]!;
      const p1 = ch[idx(i1)]!;
      const p2 = ch[idx(i1 + 1)]!;
      const p3 = ch[idx(i1 + 2)]!;
      const a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
      const b = p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3;
      const c = -0.5 * p0 + 0.5 * p2;
      out[i] = ((a * t + b) * t + c) * t + p1;
    }
    return out;
  });
}

async function wsola(
  channels: Float32Array[],
  ratio: number,
  sampleRate: number,
  cyclic: boolean,
  opts: StretchOpts,
): Promise<Float32Array[]> {
  if (Math.abs(ratio - 1) < 1e-6) return channels.map((c) => Float32Array.from(c));

  const inLen = channels[0]!.length;
  const outLen = Math.max(1, Math.round(inLen * ratio));
  const windowMs = opts.windowMs && opts.windowMs > 0 ? opts.windowMs : 80;
  const transient = Math.max(0, Math.min(1, opts.transient ?? 0));

  let win = 2 * Math.floor((sampleRate * (windowMs / 1000)) / 2);
  win = Math.min(win, 2 * Math.floor(inLen / 2));
  if (win < 16) return channels.map((c) => Float32Array.from(c));
  const half = win / 2;
  const hopOut = Math.max(1, Math.floor(win / 4)); // 75% overlap — smoother than 50%
  const hopIn = hopOut / ratio;
  const seek = Math.max(1, Math.floor(sampleRate * 0.01)); // ±10ms similarity search

  const hann = new Float32Array(win);
  for (let i = 0; i < win; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / win);

  const wrapIn = (i: number) => { i %= inLen; return i < 0 ? i + inLen : i; };
  const at = (ch: Float32Array, i: number) =>
    cyclic ? ch[wrapIn(i)]! : (i >= 0 && i < inLen ? ch[i]! : 0);

  let guide: Float32Array;
  if (channels.length === 1) {
    guide = channels[0]!;
  } else {
    guide = new Float32Array(inLen);
    for (let i = 0; i < inLen; i++) {
      let s = 0;
      for (const ch of channels) s += ch[i]!;
      guide[i] = s / channels.length;
    }
  }
  const gAt = (i: number) =>
    cyclic ? guide[wrapIn(i)]! : (i >= 0 && i < inLen ? guide[i]! : 0);

  // Onset strength (positive amplitude flux) for transient-aware grain snapping.
  let flux: Float32Array | null = null;
  let onsetThreshold = Infinity;
  if (transient > 0) {
    flux = new Float32Array(inLen);
    let maxFlux = 0;
    for (let i = 1; i < inLen; i++) {
      const d = Math.abs(guide[i]!) - Math.abs(guide[i - 1]!);
      const f = d > 0 ? d : 0;
      flux[i] = f;
      if (f > maxFlux) maxFlux = f;
    }
    // Higher transient → lower threshold → snaps to weaker onsets too.
    onsetThreshold = maxFlux * ((1 - transient) * 0.6 + 0.05);
  }

  const out = channels.map(() => new Float32Array(outLen));
  const norm = new Float32Array(outLen);

  let prevPos = 0;
  const frames = Math.ceil(outLen / hopOut);
  for (let k = 0; k < frames; k++) {
    // Report progress and yield every 16 grains: this is the dominant cost of a
    // render (and doubles for an octave pitch shift), so without yielding the
    // host progress bar freezes here for the whole stretch.
    if (opts.onProgress && (k & 15) === 0) await opts.onProgress(k / frames);
    const outPos = k * hopOut;
    const target = Math.round(k * hopIn);

    let pos = target;
    if (k > 0) {
      let snapped = false;
      if (flux) {
        // Snap this grain to the strongest onset near the target — keeps
        // attacks sharp instead of smeared/repeated.
        const lo = Math.max(0, target - seek);
        const hi = Math.min(inLen - 1, target + seek);
        let best = onsetThreshold, onsetPos = -1;
        for (let i = lo; i <= hi; i++) {
          const fv = cyclic ? flux[wrapIn(i)]! : flux[i]!;
          if (fv > best) { best = fv; onsetPos = i; }
        }
        if (onsetPos >= 0) { pos = onsetPos; snapped = true; }
      }
      if (!snapped) {
        // Phase-coherent placement: pick the input position whose waveform best
        // continues the previous grain. This is what keeps the pitch shift from
        // sounding cheap/warbly; the Akai grit comes from akaiColor instead.
        const natural = prevPos + hopOut;
        let best = -Infinity;
        for (let cand = target - seek; cand <= target + seek; cand += 2) {
          let corr = 0;
          for (let i = 0; i < half; i += 2) corr += gAt(natural + i) * gAt(cand + i);
          if (corr > best) { best = corr; pos = cand; }
        }
      }
    }

    for (let c = 0; c < channels.length; c++) {
      const ch = channels[c]!;
      const o = out[c]!;
      for (let i = 0; i < win; i++) {
        let oi = outPos + i;
        if (oi >= outLen) { if (!cyclic) break; oi %= outLen; }
        o[oi] += at(ch, pos + i) * hann[i]!;
      }
    }
    for (let i = 0; i < win; i++) {
      let oi = outPos + i;
      if (oi >= outLen) { if (!cyclic) break; oi %= outLen; }
      norm[oi] += hann[i]!;
    }

    prevPos = pos;
  }

  for (let c = 0; c < channels.length; c++) {
    const o = out[c]!;
    for (let i = 0; i < outLen; i++) {
      o[i] = norm[i]! > 1e-6 ? o[i]! / norm[i]! : 0;
    }
  }
  return out;
}
