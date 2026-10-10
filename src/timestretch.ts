// WSOLA (waveform-similarity overlap-add) time-stretch + pitch shift, shared by
// the Node processor and (compiled) the editor webview so preview and render
// agree.
//
// Pitch shift = resample + WSOLA stretch back to the tempo length. Small
// windows give a tighter, grainier character; large windows stay smooth.
// Transient preservation plays detected attacks through at their original
// speed so they are neither smeared nor repeated.
export interface StretchOpts {
  /** Pitch shift in semitones (default 0). Length is preserved. */
  pitch?: number;
  /** Grain window in ms (default 80). Smaller = tighter/grainier, larger = smoother. */
  windowMs?: number;
  /** Transient preservation 0..1: higher plays more (and weaker) attacks through intact. */
  transient?: number;
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
  if (noStretch && noPitch) return channels.map((c) => c.slice());

  const inLen = channels[0]!.length;
  const targetLen = Math.max(1, Math.round(inLen * ratio));
  if (noPitch) return wsola(channels, targetLen, sampleRate, cyclic, opts);

  if (pitchFactor > 1) {
    // Pitch up: resample (band-limited) to the shorter, higher-pitched signal
    // first, then stretch that to the target length. Resampling first keeps
    // every buffer no longer than the output, where stretching first would
    // build an intermediate up to 16× the input (4× stretch, +24 st).
    const shortLen = Math.max(1, Math.round(inLen / pitchFactor));
    const pitched = resample(channels, shortLen, cyclic, sampleRate);
    return wsola(pitched, targetLen, sampleRate, cyclic, opts);
  }
  // Pitch down: stretch to the shorter length, then resample up to the target.
  const midLen = Math.max(1, Math.round(inLen * ratio * pitchFactor));
  const stretched = await wsola(channels, midLen, sampleRate, cyclic, opts);
  return resample(stretched, targetLen, cyclic, sampleRate);
}

// Cascaded biquad (≈4th-order Butterworth) low-pass. Returns new arrays; the
// input is not modified. When cyclic, each stage's state is warmed up on the
// end of the buffer first, so a loop has no start-up transient at its seam.
function lowpass(
  channels: Float32Array[],
  fc: number,
  sampleRate: number,
  cyclic: boolean,
): Float32Array[] {
  const w0 = (2 * Math.PI * fc) / sampleRate;
  const cs = Math.cos(w0);
  const sn = Math.sin(w0);
  const out = channels.map((c) => c.slice());
  // Two stages with the Butterworth 4th-order Q values for a flat passband.
  for (const q of [0.54119610, 1.30656296]) {
    const alpha = sn / (2 * q);
    const a0 = 1 + alpha;
    const nb0 = (1 - cs) / 2 / a0, nb1 = (1 - cs) / a0, nb2 = nb0;
    const na1 = (-2 * cs) / a0, na2 = (1 - alpha) / a0;
    for (const ch of out) {
      const n = ch.length;
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      if (cyclic) {
        for (let i = Math.max(0, n - 4096); i < n; i++) {
          const x0 = ch[i]!;
          const y0 = nb0 * x0 + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
          x2 = x1; x1 = x0; y2 = y1; y1 = y0;
        }
      }
      for (let i = 0; i < n; i++) {
        const x0 = ch[i]!;
        const y0 = nb0 * x0 + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
        x2 = x1; x1 = x0; y2 = y1; y1 = y0;
        ch[i] = y0;
      }
    }
  }
  return out;
}

// Catmull-Rom cubic resample to an exact output length. When downsampling
// (pitch up), an anti-aliasing low-pass is applied first so high frequencies
// don't fold back as noise. When cyclic, indices wrap so a pitch-shifted loop
// stays seamless.
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
    src = lowpass(src, (sampleRate / 2) / step * 0.9, sampleRate, cyclic);
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
      let p0: number, p1: number, p2: number, p3: number;
      if (i1 >= 1 && i1 + 2 < n) {
        p0 = ch[i1 - 1]!; p1 = ch[i1]!; p2 = ch[i1 + 1]!; p3 = ch[i1 + 2]!;
      } else {
        p0 = ch[idx(i1 - 1)]!; p1 = ch[idx(i1)]!; p2 = ch[idx(i1 + 1)]!; p3 = ch[idx(i1 + 2)]!;
      }
      const a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
      const b = p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3;
      const c = -0.5 * p0 + 0.5 * p2;
      out[i] = ((a * t + b) * t + c) * t + p1;
    }
    return out;
  });
}

// Onset sample positions (block starts where the short-term level jumps),
// strongest-first filtering by the transient amount, returned in time order.
export function detectOnsets(guide: Float32Array, sampleRate: number, transient: number): number[] {
  const n = guide.length;
  const block = Math.max(16, Math.round(sampleRate * 0.005));
  const blocks = Math.floor(n / block);
  if (blocks < 2) return [];
  const level = new Float32Array(blocks);
  let maxLevel = 0;
  for (let b = 0; b < blocks; b++) {
    let s = 0;
    for (let i = b * block, e = i + block; i < e; i++) s += guide[i]! * guide[i]!;
    level[b] = Math.sqrt(s / block);
    if (level[b]! > maxLevel) maxLevel = level[b]!;
  }
  // Rise against the quieter of the two previous blocks, so an attack spread
  // over two blocks still registers in full.
  let maxRise = 0;
  const rise = new Float32Array(blocks);
  for (let b = 1; b < blocks; b++) {
    const before = b > 1 ? Math.min(level[b - 1]!, level[b - 2]!) : level[b - 1]!;
    const d = level[b]! - before;
    // An attack is a jump of at least 3 dB over what came before; level ripple
    // on a steady tone is far below that.
    rise[b] = d > 0 && level[b]! > before * 1.41 && level[b]! > maxLevel * 0.02 ? d : 0;
    if (rise[b]! > maxRise) maxRise = rise[b]!;
  }
  // Higher transient → lower threshold → weaker onsets count too.
  const threshold = maxRise * ((1 - transient) * 0.6 + 0.05);
  const onsets: number[] = [];
  let last = -Infinity;
  for (let b = 1; b < blocks; b++) {
    // Local peak of the rise, so one attack spanning blocks counts once.
    if (rise[b]! > 0 && rise[b]! > threshold && rise[b]! >= rise[b - 1]!
      && rise[b]! >= (rise[b + 1] ?? 0) && b - last > 2) {
      onsets.push((b - 1) * block);
      last = b;
    }
  }
  return onsets;
}

// Stretches each channel to exactly outLen samples.
async function wsola(
  channels: Float32Array[],
  outLen: number,
  sampleRate: number,
  cyclic: boolean,
  opts: StretchOpts,
): Promise<Float32Array[]> {
  const inLen = channels[0]!.length;
  if (outLen === inLen) return channels.map((c) => c.slice());
  const ratio = outLen / inLen;
  const windowMs = opts.windowMs && opts.windowMs > 0 ? opts.windowMs : 80;
  const transient = Math.max(0, Math.min(1, opts.transient ?? 0));

  let win = 2 * Math.floor((sampleRate * (windowMs / 1000)) / 2);
  win = Math.min(win, 2 * Math.floor(inLen / 2));
  // Too short to grain: a plain resample still gives the exact length.
  if (win < 16) return resample(channels, outLen, cyclic, sampleRate);
  const half = win / 2;
  const hopOut = Math.max(1, Math.floor(win / 4)); // 75% overlap
  const hopIn = hopOut / ratio;
  const seek = Math.max(1, Math.floor(sampleRate * 0.01)); // ±10ms similarity search

  const hann = new Float32Array(win);
  for (let i = 0; i < win; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / win);

  let guide: Float32Array;
  if (channels.length === 1) {
    guide = channels[0]!;
  } else {
    guide = new Float32Array(inLen);
    const k = 1 / channels.length;
    for (const ch of channels) for (let i = 0; i < inLen; i++) guide[i] += ch[i]! * k;
  }
  // Padded copy of the guide so the similarity search reads it without bounds
  // checks or modulo: wrapped when cyclic, zeros otherwise.
  const pad = seek + win + hopOut;
  const gp = new Float32Array(inLen + 2 * pad);
  if (cyclic) {
    for (let j = 0; j < gp.length; j++) gp[j] = guide[(((j - pad) % inLen) + inLen) % inLen]!;
  } else {
    gp.set(guide, pad);
  }
  const corrAt = (a: number, b: number, step: number): number => {
    let s = 0;
    a += pad; b += pad;
    for (let i = 0; i < half; i += step) s += gp[a + i]! * gp[b + i]!;
    return s;
  };

  // Onsets, duplicated one cycle on so a looped attack near the start is
  // found again as the read position wraps past the end.
  let onsets = transient > 0 ? detectOnsets(guide, sampleRate, transient) : [];
  if (cyclic && onsets.length) onsets = onsets.concat(onsets.map((s) => s + inLen));
  let nextOnset = 0;
  let lockUntil = -Infinity; // play-through continues while pos <= lockUntil
  let offset = 0;            // read position minus the nominal one, after a lock

  const out = channels.map(() => new Float32Array(outLen));
  const norm = new Float32Array(outLen);
  const wrapIn = (i: number) => ((i % inLen) + inLen) % inLen;

  let prevPos = 0;
  const frames = Math.ceil(outLen / hopOut);
  for (let k = 0; k < frames; k++) {
    // Report progress and yield every 16 grains: this is the dominant cost of a
    // render, so without yielding the host progress bar freezes here.
    if (opts.onProgress && (k & 15) === 0) await opts.onProgress(k / frames);
    const outPos = k * hopOut;
    // Non-cyclic: the grain must read only real samples. Near the end the
    // grain is cut at outLen, so it may start later, ending on the last sample.
    const maxPos = cyclic ? Infinity : inLen - Math.min(win, outLen - outPos);

    let pos = 0;
    if (k > 0) {
      const natural = prevPos + hopOut;
      // Skip onsets already behind the read position.
      while (nextOnset < onsets.length && onsets[nextOnset]! < prevPos) nextOnset++;
      if (nextOnset < onsets.length && onsets[nextOnset]! < natural + win) {
        // An attack enters this grain: play it through at the original speed
        // until it is a search radius behind, so no later grain re-reads it.
        lockUntil = onsets[nextOnset]! + seek;
        nextOnset++;
      }
      // Nominal read position, plus any lead/lag a play-through left behind,
      // which is eased out so the overall length still comes out right.
      const target = outPos / ratio + offset;
      if (natural <= lockUntil && natural <= maxPos) {
        pos = natural;
        offset = pos - outPos / ratio;
      } else {
        const step = Math.max(1, hopIn / 2);
        offset = offset > 0 ? Math.max(0, offset - step) : Math.min(0, offset + step);
        // Clamp the target before searching around it, so near the end the
        // search still has room to find a phase-matched grain instead of
        // collapsing onto one position (which repeats out of phase and cancels).
        const t = cyclic ? Math.round(target) : Math.max(0, Math.min(maxPos, Math.round(target)));
        let lo = t - seek, hi = t + seek;
        if (!cyclic) { lo = Math.max(0, lo); hi = Math.min(maxPos, hi); }
        // Coarse-to-fine search for the position that best continues the
        // previous grain: decimated pass, then full resolution around the best.
        let best = -Infinity, coarse = lo;
        for (let cand = lo; cand <= hi; cand += 4) {
          const c = corrAt(natural, cand, 4);
          if (c > best) { best = c; coarse = cand; }
        }
        best = -Infinity; pos = coarse;
        for (let cand = Math.max(lo, coarse - 3); cand <= Math.min(hi, coarse + 3); cand++) {
          const c = corrAt(natural, cand, 2);
          if (c > best) { best = c; pos = cand; }
        }
      }
    }

    const span = Math.min(win, cyclic ? win : outLen - outPos);
    const direct = pos >= 0 && pos + span <= inLen;
    for (let c = 0; c < channels.length; c++) {
      const ch = channels[c]!;
      const o = out[c]!;
      for (let i = 0; i < span; i++) {
        let oi = outPos + i;
        if (oi >= outLen) oi -= outLen; // only reachable when cyclic
        o[oi] += (direct ? ch[pos + i]! : ch[wrapIn(pos + i)]!) * hann[i]!;
      }
    }
    for (let i = 0; i < span; i++) {
      let oi = outPos + i;
      if (oi >= outLen) oi -= outLen;
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
