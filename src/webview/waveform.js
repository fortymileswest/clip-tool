class WaveformCanvas {
  constructor(canvasEl, containerEl) {
    this.canvas = canvasEl;
    this.container = containerEl;
    this.ctx = canvasEl.getContext('2d');
    this.data = null;
    this.samples = null;        // raw Float32Array per channel, set once audio is decoded
    this.displaySamples = null; // samples after channel-mode derivation
    this.channelMode = 'stereo';
    this.zoom = 1;
    this.maxZoom = 20;
    this.scrollX = 0;
    this.gainLinear = 1;
    this.trimStart = 0;
    this.trimEnd = 0;
    this.playhead = 0;
    this.onPlayheadSeek = null;
    this.loopStart = null;
    this.loopEnd = null;
    this.loopEnabled = false; // matches controls.js; set on by the Loop toggle
    this.snapZC = false;
    this.fadeIn = { len: 0, type: 'linear', bend: 0 };
    this.fadeOut = { len: 0, type: 'linear', bend: 0 };
    this.detectedBpm = null; // set by controls.js tempo detection
    this.beatPhase = 0;      // time (s) of the first detected beat
    this.dragging = null;
    this._setupResize();
    this._setupDrag();
  }

  load(waveformData) {
    this.data = waveformData;
    // New audio invalidates the previous full-resolution samples — clear them
    // so a stale, wrong-length displaySamples can't be drawn against the new
    // peaks (which threw mid-draw and aborted a trim, reverting the channel
    // view to stereo). setSampleData repopulates them.
    this.samples = null;
    this.displaySamples = null;
    // Stale tempo no longer applies to the new audio; re-detected after load.
    this.detectedBpm = null;
    this.beatPhase = 0;
    this.displayPeaks = waveformData.peaks;
    this.trimStart = 0;
    this.trimEnd = waveformData.duration;
    // Fades are NOT reset here: Trim to Selection narrows the view to the
    // selection, and the fades (anchored to the selection edges) should carry
    // over so the preview keeps reflecting them. They start at zero from the
    // constructor for the initial load.
    // Allow zooming all the way to individual samples: at max zoom one sample
    // spans ~8px regardless of sample count.
    const frames = waveformData.duration * waveformData.sampleRate;
    this.maxZoom = Math.max(20, Math.ceil((frames * 8) / Math.max(1, this.canvas.width || 960)));
    this._resize();
    // Re-derive the displayed peaks for the current channel mode rather than
    // forcing stereo, so a trim preserves a mono left/right/mixed/side view.
    this.setChannelMode(this.channelMode);
  }

  // Full-resolution audio decoded by controls.js — enables sample-level zoom.
  setSampleData(channels) {
    this.samples = channels;
    this.setChannelMode(this.channelMode);
  }

  // Recompute displayed peaks (and samples, when available) for a channel mode.
  // Peak mixed/side combine the per-block min/max envelopes of L and R — a
  // bounding approximation; the sample path computes the true result.
  setChannelMode(mode) {
    this.channelMode = mode;
    const peaks = this.data.peaks;
    if (mode === 'stereo' || peaks.length === 1) {
      this.displayPeaks = peaks;
    } else {
      const L = peaks[0];
      const R = peaks[1];
      const out = new Array(L.length);
      for (let i = 0; i < L.length; i += 2) {
        const minL = L[i], maxL = L[i + 1];
        const minR = R[i], maxR = R[i + 1];
        let mn, mx;
        if (mode === 'left') { mn = minL; mx = maxL; }
        else if (mode === 'right') { mn = minR; mx = maxR; }
        else if (mode === 'mixed') { mn = 0.5 * minL + 0.5 * minR; mx = 0.5 * maxL + 0.5 * maxR; }
        else { mn = 0.5 * minL - 0.5 * maxR; mx = 0.5 * maxL - 0.5 * minR; } // side
        out[i] = mn;
        out[i + 1] = mx;
      }
      this.displayPeaks = [out];
    }

    if (this.samples) {
      const s = this.samples;
      if (mode === 'stereo' || s.length === 1) {
        this.displaySamples = s;
      } else if (mode === 'left') {
        this.displaySamples = [s[0]];
      } else if (mode === 'right') {
        this.displaySamples = [s[1] || s[0]];
      } else {
        const L = s[0];
        const R = s[1] || s[0];
        const out = new Float32Array(L.length);
        const sign = mode === 'mixed' ? 1 : -1;
        for (let i = 0; i < L.length; i++) out[i] = 0.5 * L[i] + sign * 0.5 * R[i];
        this.displaySamples = [out];
      }
    }

    this.draw();
  }

  setZoom(zoom) {
    this.zoom = Math.max(1, Math.min(this.maxZoom, zoom));
    this._clampScroll();
    this._syncZoomSlider();
    this.draw();
  }

  setGain(db) {
    this.gainLinear = Math.pow(10, db / 20);
    this.draw();
  }

  // Zoom so the current selection fills ~90% of the viewport, centred.
  zoomToSelection() {
    if (!this.data || this.data.duration <= 0) return;
    const selLen = this.trimEnd - this.trimStart;
    if (selLen <= 0) return;
    this.zoom = Math.max(1, Math.min(this.maxZoom, (this.data.duration / selLen) * 0.9));
    const total = this._totalWidth();
    const selStartPx = (this.trimStart / this.data.duration) * total;
    const selWidthPx = (selLen / this.data.duration) * total;
    this.scrollX = selStartPx - (this.canvas.width - selWidthPx) / 2;
    this._clampScroll();
    this._syncZoomSlider();
    this.draw();
  }

  setPlayhead(t) {
    if (!this.data) return;
    this.playhead = Math.max(0, Math.min(this.data.duration, t));
    this.draw();
  }

  setLoop(start, end) {
    if (!this.data) return;
    const s = Math.max(0, start);
    const e = Math.min(this.data.duration, end);
    if (e - s < 0.01) return;
    this.loopStart = s;
    this.loopEnd = e;
    this.draw();
  }

  clearLoop() {
    this.loopStart = null;
    this.loopEnd = null;
    this.draw();
  }

  get hasLoop() {
    return this.loopStart !== null && this.loopEnd !== null;
  }

  // Nearest zero crossing to time t (mono mix of channels), searching up to
  // one second outward. Returns t unchanged if audio is not decoded yet.
  _snapToZC(t) {
    const s = this.samples;
    if (!s || !this.data) return t;
    const sr = this.data.sampleRate;
    const L = s[0];
    const R = s[1];
    const n = L.length;
    const val = (i) => (R ? 0.5 * (L[i] + R[i]) : L[i]);
    const i0 = Math.max(1, Math.min(n - 1, Math.round(t * sr)));
    const maxDist = Math.min(n - 1, Math.ceil(sr));
    for (let d = 0; d <= maxDist; d++) {
      for (const i of d === 0 ? [i0] : [i0 - d, i0 + d]) {
        if (i < 1 || i >= n) continue;
        const a = val(i - 1);
        const b = val(i);
        if (b === 0 || (a < 0 && b > 0) || (a > 0 && b < 0)) {
          return i / sr;
        }
      }
    }
    return t;
  }

  _setupResize() {
    const ro = new ResizeObserver(() => this._resize());
    ro.observe(this.container);
  }

  _resize() {
    this.canvas.width = this.container.clientWidth;
    this.canvas.height = this.container.clientHeight;
    this._clampScroll();
    this.draw();
  }

  _totalWidth() {
    return this.canvas.width * this.zoom;
  }

  _clampScroll() {
    const maxScroll = Math.max(0, this._totalWidth() - this.canvas.width);
    this.scrollX = Math.max(0, Math.min(this.scrollX, maxScroll));
  }

  _timeToX(t) {
    if (!this.data || this.data.duration <= 0) return 0;
    return (t / this.data.duration) * this._totalWidth() - this.scrollX;
  }

  _xToTime(x) {
    if (!this.data || this.data.duration <= 0 || this._totalWidth() === 0) return 0;
    return ((x + this.scrollX) / this._totalWidth()) * this.data.duration;
  }

  draw() {
    if (!this.data || this.data.duration <= 0 || !this.data.peaks.length) return;
    const { ctx, canvas } = this;
    const { width, height } = canvas;
    const peaks = this.displayPeaks || this.data.peaks;
    const numChannels = peaks.length;
    const channelHeight = height / numChannels;

    ctx.clearRect(0, 0, width, height);

    // Draw trim region background
    const trimX1 = this._timeToX(this.trimStart);
    const trimX2 = this._timeToX(this.trimEnd);
    ctx.fillStyle = 'hsla(140,100%,78%,0.20)';
    ctx.fillRect(trimX1, 0, trimX2 - trimX1, height);

    // Beyond ~2px per peak block the 2000-point envelope turns blocky; switch
    // to true sample rendering once decoded audio is available.
    const useSamples = this.displaySamples
      && this._totalWidth() / (peaks[0].length / 2) > 2;

    for (let c = 0; c < numChannels; c++) {
      const yCenter = channelHeight * c + channelHeight / 2;
      const halfH = channelHeight / 2 - 4;

      if (useSamples) {
        this._drawChannelSamples(this.displaySamples[c], yCenter, halfH);
      } else {
        this._drawChannelPeaks(peaks[c], yCenter, halfH);
      }

      // Zero line
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.strokeStyle = 'hsla(140,100%,78%,0.45)';
      ctx.lineWidth = 1;
      ctx.moveTo(0, yCenter + 0.5);
      ctx.lineTo(width, yCenter + 0.5);
      ctx.stroke();
    }

    // Beat grid — selection divided into bars/beats
    this._drawBeatGrid(width, height);

    // Loop region — blue, with handles anchored at the bottom (trim sits at the top)
    if (this.hasLoop) {
      const lx1 = this._timeToX(this.loopStart);
      const lx2 = this._timeToX(this.loopEnd);
      const loopAlpha = this.loopEnabled ? 1 : 0.4;
      ctx.globalAlpha = loopAlpha;
      ctx.fillStyle = 'hsla(140,80%,70%,0.10)';
      ctx.fillRect(lx1, 0, lx2 - lx1, height);
      this._drawLoopHandle(lx1, height, 'start', loopAlpha);
      this._drawLoopHandle(lx2, height, 'end', loopAlpha);
      ctx.globalAlpha = 1;
    }

    // Fades — curve overlay, corner handle, and mid-curve shape node
    this._drawFade('in', height, width);
    this._drawFade('out', height, width);

    // Trim handles
    this._drawHandle(trimX1, height, 'start');
    this._drawHandle(trimX2, height, 'end');

    // Playhead
    const px = Math.round(this._timeToX(this.playhead));
    if (px >= 0 && px <= width) {
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.strokeStyle = 'hsla(140,100%,80%,0.9)';
      ctx.lineWidth = 1;
      ctx.moveTo(px + 0.5, 0);
      ctx.lineTo(px + 0.5, height);
      ctx.stroke();
    }

    this._updateBpm();
  }

  // BPM from the selection length, treating it as bars × beats. Exact for a
  // cleanly cut selection — no onset detection. draw() calls this every frame,
  // so the DOM refs are cached.
  _updateBpm() {
    const el = (this._bpmEl ??= document.getElementById('bpm-label'));
    if (!el || !this.data) return;
    // Detected tempo first (no manual entry needed).
    if (this.detectedBpm && this.detectedBpm >= 20 && this.detectedBpm <= 999) {
      el.textContent = `${this.detectedBpm.toFixed(2)} BPM`;
      return;
    }
    const bars = this._bars();
    const beats = this._beats();
    const len = this.trimEnd - this.trimStart;
    if (len <= 0 || !bars || !beats) {
      el.textContent = '';
      return;
    }
    const bpm = (bars * beats * 60) / len;
    el.textContent = bpm >= 20 && bpm <= 999 ? `${bpm.toFixed(2)} BPM` : '—';
  }

  _bars() {
    const sel = (this._barsSel ??= document.getElementById('bars-select'));
    return sel ? Number(sel.value) : 0;
  }

  _beats() {
    const sel = (this._beatsSel ??= document.getElementById('beats-select'));
    return sel ? Number(sel.value) : 0;
  }

  // Beat grid over the selection: the selection spans bars × beats, drawn as
  // vertical lines (bar lines brighter, with bar numbers). Hidden when the
  // implied tempo is out of a sane range, i.e. the selection isn't a clean
  // bars×beats length.
  _drawBeatGrid(width, height) {
    if (!this.data) return;
    const beats = this._beats() || 4; // beats per bar, for bar grouping

    // Detected tempo drives the grid across the whole view; otherwise fall back
    // to dividing the selection by bars × beats (manual mode).
    let phase, interval, fromT, toT;
    if (this.detectedBpm && this.detectedBpm >= 20 && this.detectedBpm <= 999) {
      interval = 60 / this.detectedBpm;
      phase = this.beatPhase || 0;
      fromT = Math.max(0, phase);
      toT = this.data.duration;
    } else {
      const bars = this._bars();
      const sel = this.trimEnd - this.trimStart;
      if (!bars || !beats || sel <= 0) return;
      const bpm = (bars * beats * 60) / sel;
      if (bpm < 20 || bpm > 999) return;
      interval = sel / (bars * beats);
      phase = this.trimStart;
      fromT = this.trimStart;
      toT = this.trimEnd;
    }
    if (interval <= 0) return;

    // Density guard: hide beat subdivisions, then bars, as lines get crowded.
    const beatPx = (interval / this.data.duration) * this._totalWidth();
    const drawBeats = beatPx >= 6;
    if (beatPx * beats < 4) return; // even bar lines too dense to be useful

    const ctx = this.ctx;
    ctx.save();
    ctx.font = '9px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    const firstK = Math.ceil((fromT - phase) / interval - 1e-6);
    const lastK = Math.floor((toT - phase) / interval + 1e-6);
    for (let k = firstK; k <= lastK; k++) {
      const isBar = ((k % beats) + beats) % beats === 0;
      if (!isBar && !drawBeats) continue;
      const x = this._timeToX(phase + k * interval);
      if (x < -1 || x > width + 1) continue;
      ctx.globalAlpha = 1;
      ctx.strokeStyle = isBar ? 'hsla(140,60%,65%,0.55)' : 'hsla(140,60%,65%,0.22)';
      ctx.lineWidth = isBar ? 1 : 0.5;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, height);
      ctx.stroke();
      if (isBar && k >= 0) {
        ctx.fillStyle = 'hsla(140,60%,80%,0.85)';
        ctx.fillText(String(Math.floor(k / beats) + 1), x + 3, 2);
      }
    }
    ctx.restore();
  }

  _drawChannelPeaks(chPeaks, yCenter, halfH) {
    const { ctx, canvas } = this;
    const width = canvas.width;
    const peakCount = chPeaks.length / 2;
    const pxPerPeak = this._totalWidth() / peakCount;
    const startPeak = Math.floor(this.scrollX / pxPerPeak);
    const endPeak = Math.min(peakCount, Math.ceil((this.scrollX + width) / pxPerPeak));

    // Faded (outside trim)
    ctx.globalAlpha = 0.42;
    ctx.strokeStyle = '#c8ffe0';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = startPeak; i < endPeak; i++) {
      const x = i * pxPerPeak - this.scrollX;
      const env = this._envelopeAt(this._xToTime(x));
      const minVal = chPeaks[i * 2] * this.gainLinear * env;
      const maxVal = chPeaks[i * 2 + 1] * this.gainLinear * env;
      const clampedMin = Math.max(-1, minVal);
      const clampedMax = Math.min(1, maxVal);
      const y1 = yCenter - clampedMax * halfH;
      const y2 = yCenter - clampedMin * halfH;
      ctx.moveTo(x, y1);
      ctx.lineTo(x, Math.max(y1 + 1, y2));
    }
    ctx.stroke();

    // Bright (inside trim)
    ctx.globalAlpha = 1;
    ctx.beginPath();
    for (let i = startPeak; i < endPeak; i++) {
      const x = i * pxPerPeak - this.scrollX;
      const t = this._xToTime(x);
      if (t < this.trimStart || t > this.trimEnd) continue;
      const env = this._envelopeAt(t);
      const minVal = chPeaks[i * 2] * this.gainLinear * env;
      const maxVal = chPeaks[i * 2 + 1] * this.gainLinear * env;
      const clampedMin = Math.max(-1, minVal);
      const clampedMax = Math.min(1, maxVal);
      const y1 = yCenter - clampedMax * halfH;
      const y2 = yCenter - clampedMin * halfH;
      ctx.moveTo(x, y1);
      ctx.lineTo(x, Math.max(y1 + 1, y2));
    }
    ctx.stroke();
  }

  _drawChannelSamples(chan, yCenter, halfH) {
    const { ctx, canvas } = this;
    const width = canvas.width;
    const total = this._totalWidth();
    const frames = chan.length;
    const samplesPerPx = frames / total;
    const g = this.gainLinear;
    const sampleY = (v) => yCenter - Math.max(-1, Math.min(1, v * g)) * halfH;

    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#c8ffe0';
    ctx.lineWidth = 1;

    if (samplesPerPx >= 1) {
      // Multiple samples per pixel: min/max column per pixel.
      ctx.beginPath();
      for (let x = 0; x < width; x++) {
        const i0 = Math.max(0, Math.floor((x + this.scrollX) * samplesPerPx));
        if (i0 >= frames) break;
        const i1 = Math.min(frames, Math.max(i0 + 1, Math.ceil((x + 1 + this.scrollX) * samplesPerPx)));
        let mn = Infinity, mx = -Infinity;
        for (let i = i0; i < i1; i++) {
          const v = chan[i];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        const env = this._envelopeAt(this._xToTime(x));
        const y1 = sampleY(mx * env);
        const y2 = sampleY(mn * env);
        ctx.moveTo(x + 0.5, y1);
        ctx.lineTo(x + 0.5, Math.max(y1 + 1, y2));
      }
      ctx.stroke();
    } else {
      // Sample level: connected line, with dots once samples are far apart.
      const pxPerSample = total / frames;
      const iStart = Math.max(0, Math.floor(this.scrollX / pxPerSample) - 1);
      const iEnd = Math.min(frames, Math.ceil((this.scrollX + width) / pxPerSample) + 1);
      ctx.beginPath();
      for (let i = iStart; i < iEnd; i++) {
        const x = i * pxPerSample - this.scrollX;
        const y = sampleY(chan[i] * this._envelopeAt(this._xToTime(x)));
        if (i === iStart) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      if (pxPerSample > 6) {
        ctx.fillStyle = '#c8ffe0';
        for (let i = iStart; i < iEnd; i++) {
          const x = i * pxPerSample - this.scrollX;
          const y = sampleY(chan[i] * this._envelopeAt(this._xToTime(x)));
          ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
        }
      }
    }
  }

  // Time bounds of a fade region: 'in' grows from trimStart, 'out' shrinks
  // back from trimEnd.
  _fadeRange(which) {
    const spec = which === 'in' ? this.fadeIn : this.fadeOut;
    // Clamp to the selection so a shrunken selection cannot leave a fade
    // overhanging it.
    const len = Math.min(spec.len, Math.max(0, this.trimEnd - this.trimStart));
    if (which === 'in') return { spec, len, t0: this.trimStart, t1: this.trimStart + len };
    return { spec, len, t0: this.trimEnd - len, t1: this.trimEnd };
  }

  // Combined fade envelope (fade-in × fade-out) at time t; 1 when no fades.
  // Applied to the drawn waveform amplitude so the taper is visible directly.
  _envelopeAt(t) {
    let g = 1;
    if (this.fadeIn.len > 0) g *= this._fadeGainAt('in', t);
    if (this.fadeOut.len > 0) g *= this._fadeGainAt('out', t);
    return g;
  }

  // Gain at time t for one fade (1 = unity).
  _fadeGainAt(which, t) {
    const { spec, len, t0, t1 } = this._fadeRange(which);
    if (len <= 0 || t1 <= t0) return 1;
    const p = (t - t0) / (t1 - t0);
    if (p <= 0) return which === 'in' ? 0 : 1;
    if (p >= 1) return which === 'in' ? 1 : 0;
    return window.Fades.fadeGain(which === 'in' ? p : 1 - p, spec.type, spec.bend);
  }

  _fadeHandleXY(which) {
    const { t0, t1 } = this._fadeRange(which);
    return { x: this._timeToX(which === 'in' ? t1 : t0), y: 7 };
  }

  _fadeNodeXY(which, height) {
    const { len, t0, t1 } = this._fadeRange(which);
    if (len <= 0) return null;
    const tm = (t0 + t1) / 2;
    const g = this._fadeGainAt(which, tm);
    return { x: this._timeToX(tm), y: (1 - g) * height };
  }

  _drawFade(which, height, width) {
    const ctx = this.ctx;
    const { len, t0, t1 } = this._fadeRange(which);
    const handle = this._fadeHandleXY(which);

    if (len > 0) {
      const x0 = this._timeToX(t0);
      const x1 = this._timeToX(t1);
      if (x1 >= 0 && x0 <= width) {
        // Curve line plus a darkened region above it (the attenuated part).
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.moveTo(x0, which === 'in' ? height : 0);
        const STEPS = 48;
        for (let i = 0; i <= STEPS; i++) {
          const t = t0 + ((t1 - t0) * i) / STEPS;
          const g = this._fadeGainAt(which, t);
          ctx.lineTo(this._timeToX(t), (1 - g) * height);
        }
        ctx.strokeStyle = '#c64a3a';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.lineTo(x1, 0);
        ctx.lineTo(x0, 0);
        ctx.closePath();
        // Subtle now that the waveform itself tapers — the curve line and node
        // remain as the editing affordance.
        ctx.fillStyle = 'hsla(0,0%,0%,0.18)';
        ctx.fill();

        const node = this._fadeNodeXY(which, height);
        if (node && node.x >= 0 && node.x <= width) {
          ctx.beginPath();
          ctx.arc(node.x, node.y, 4, 0, 2 * Math.PI);
          ctx.fillStyle = '#c64a3a';
          ctx.fill();
          ctx.strokeStyle = 'hsla(0,0%,0%,0.6)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    }

    // Corner handle — always drawn so a fade can be created by grabbing it.
    if (handle.x >= -8 && handle.x <= width + 8) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#c64a3a';
      ctx.fillRect(handle.x - 4, handle.y - 4, 8, 8);
      ctx.strokeStyle = 'hsla(0,0%,0%,0.6)';
      ctx.lineWidth = 1;
      ctx.strokeRect(handle.x - 4, handle.y - 4, 8, 8);
    }
  }

  _drawHandle(x, height, type) {
    const ctx = this.ctx;
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#c8ffe0';
    ctx.beginPath();
    if (type === 'start') {
      ctx.moveTo(x, 0);
      ctx.lineTo(x + 10, 0);
      ctx.lineTo(x, 10);
      ctx.closePath();
    } else {
      ctx.moveTo(x, 0);
      ctx.lineTo(x - 10, 0);
      ctx.lineTo(x, 10);
      ctx.closePath();
    }
    ctx.fill();
    ctx.beginPath();
    ctx.strokeStyle = '#c8ffe0';
    ctx.lineWidth = 1.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  _drawLoopHandle(x, height, type, alpha = 1) {
    const ctx = this.ctx;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#7fd8a0';
    ctx.beginPath();
    if (type === 'start') {
      ctx.moveTo(x, height);
      ctx.lineTo(x + 10, height);
      ctx.lineTo(x, height - 10);
      ctx.closePath();
    } else {
      ctx.moveTo(x, height);
      ctx.lineTo(x - 10, height);
      ctx.lineTo(x, height - 10);
      ctx.closePath();
    }
    ctx.fill();
    ctx.beginPath();
    ctx.strokeStyle = '#7fd8a0';
    ctx.lineWidth = 1.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  _setupDrag() {
    this._dragController = new AbortController();
    const { signal } = this._dragController;

    this.canvas.addEventListener('mousedown', (e) => {
      if (!this.data) return;
      const x = e.offsetX;
      const y = e.offsetY;
      const startX = this._timeToX(this.trimStart);
      const endX = this._timeToX(this.trimEnd);
      const loopStartX = this.hasLoop ? this._timeToX(this.loopStart) : null;
      const loopEndX = this.hasLoop ? this._timeToX(this.loopEnd) : null;

      // Fade corner handles (top strip) and shape nodes take priority.
      for (const which of ['in', 'out']) {
        const h = this._fadeHandleXY(which);
        if (y <= 14 && Math.abs(x - h.x) < 8) {
          this.dragging = which === 'in' ? 'fadeInLen' : 'fadeOutLen';
          return;
        }
        const node = this._fadeNodeXY(which, this.canvas.height);
        if (node && Math.abs(x - node.x) < 8 && Math.abs(y - node.y) < 8) {
          this.dragging = which === 'in' ? 'fadeInBend' : 'fadeOutBend';
          const spec = which === 'in' ? this.fadeIn : this.fadeOut;
          this._bendDragStart = { y, bend: spec.bend };
          return;
        }
      }

      if (Math.abs(x - startX) < 10) {
        this.dragging = 'start';
      } else if (Math.abs(x - endX) < 10) {
        this.dragging = 'end';
      } else if (loopStartX !== null && Math.abs(x - loopStartX) < 10) {
        this.dragging = 'loopStart';
      } else if (loopEndX !== null && Math.abs(x - loopEndX) < 10) {
        this.dragging = 'loopEnd';
      } else {
        // Could become either a click (playhead) or a drag (new selection) —
        // decided by whether the pointer moves before mouseup.
        this.dragging = 'maybe-select';
        this._dragAnchorX = x;
        const anchorT = this._xToTime(x);
        this._dragAnchorT = this.snapZC ? this._snapToZC(anchorT) : anchorT;
        this.setPlayhead(anchorT);
      }
    });

    this.canvas.addEventListener('mousemove', (e) => {
      if (!this.dragging || !this.data) return;
      const t = Math.max(0, Math.min(this.data.duration, this._xToTime(e.offsetX)));
      const selLen = this.trimEnd - this.trimStart;
      if (this.dragging === 'fadeInLen') {
        this.fadeIn.len = Math.max(0, Math.min(selLen, t - this.trimStart));
        this.draw();
        return;
      }
      if (this.dragging === 'fadeOutLen') {
        this.fadeOut.len = Math.max(0, Math.min(selLen, this.trimEnd - t));
        this.draw();
        return;
      }
      if (this.dragging === 'fadeInBend' || this.dragging === 'fadeOutBend') {
        const spec = this.dragging === 'fadeInBend' ? this.fadeIn : this.fadeOut;
        // Drag down bulges the curve down (slower), up bulges it up (faster).
        spec.bend = Math.max(-1, Math.min(1,
          this._bendDragStart.bend + (e.offsetY - this._bendDragStart.y) / 80));
        this.draw();
        return;
      }
      if (this.dragging === 'maybe-select' && Math.abs(e.offsetX - this._dragAnchorX) > 4) {
        this.dragging = 'select';
      }
      const ts = this.snapZC ? this._snapToZC(t) : t;
      if (this.dragging === 'select') {
        const a = this._dragAnchorT;
        this.trimStart = Math.max(0, Math.min(a, ts));
        this.trimEnd = Math.min(this.data.duration, Math.max(this.trimStart + 0.01, Math.max(a, ts)));
        this.draw();
        this._updateTrimInfo();
        return;
      }
      if (this.dragging === 'maybe-select') return;
      if (this.dragging === 'loopStart') {
        this.loopStart = Math.min(ts, this.loopEnd - 0.01);
        this.draw();
        return;
      }
      if (this.dragging === 'loopEnd') {
        this.loopEnd = Math.max(ts, this.loopStart + 0.01);
        this.draw();
        return;
      }
      if (this.dragging === 'start') {
        this.trimStart = Math.min(ts, this.trimEnd - 0.01);
      } else {
        this.trimEnd = Math.max(ts, this.trimStart + 0.01);
      }
      this.draw();
      this._updateTrimInfo();
    });

    window.addEventListener('mouseup', () => {
      // A press that never turned into a selection drag is a click: seek.
      if (this.dragging === 'maybe-select' && this.onPlayheadSeek) {
        this.onPlayheadSeek(this.playhead);
      }
      this.dragging = null;
    }, { signal });

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!this.data) return;
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        // Two-finger vertical swipe: zoom, keeping the time under the cursor
        // fixed in place. Swipe up zooms in.
        const anchorTime = this._xToTime(e.offsetX);
        const newZoom = Math.max(1, Math.min(this.maxZoom, this.zoom * Math.exp(-e.deltaY * 0.01)));
        if (newZoom === this.zoom) return;
        this.zoom = newZoom;
        this.scrollX = (anchorTime / this.data.duration) * this._totalWidth() - e.offsetX;
        this._clampScroll();
        this._syncZoomSlider();
        this.draw();
      } else {
        this.scrollX += e.deltaX;
        this._clampScroll();
        this.draw();
      }
    }, { passive: false });
  }

  destroy() {
    this._dragController?.abort();
  }

  // Slider position is logarithmic in zoom so the huge 1×–sample-level range
  // stays controllable.
  _syncZoomSlider() {
    const slider = document.getElementById('zoom-slider');
    if (!slider) return;
    const max = Number(slider.max) || 100;
    const denom = Math.log(this.maxZoom);
    slider.value = denom > 0 ? 1 + (max - 1) * (Math.log(this.zoom) / denom) : 1;
  }

  _updateTrimInfo() {
    const fmtTime = (s) => {
      const m = Math.floor(s / 60);
      const sec = (s % 60).toFixed(3);
      return `${m}:${sec.padStart(6, '0')}`;
    };
    const el = document.getElementById('trim-info');
    if (el) {
      const dur = this.trimEnd - this.trimStart;
      el.textContent = `Trim: ${fmtTime(this.trimStart)} – ${fmtTime(this.trimEnd)} (${dur.toFixed(3)}s)`;
    }
  }
}

window.WaveformCanvas = WaveformCanvas;
