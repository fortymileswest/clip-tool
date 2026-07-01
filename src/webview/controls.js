function sendToExtension(msg) {
  if (window.webkit?.messageHandlers?.live) {
    window.webkit.messageHandlers.live.postMessage(msg);
  } else if (window.chrome?.webview) {
    window.chrome.webview.postMessage(msg);
  } else {
    console.error('[Audio Editor] No postMessage bridge available');
  }
}

function closeWithResult(result) {
  sendToExtension({ method: 'close_and_send', params: [JSON.stringify(result)] });
}

function fmtTime(s) {
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(3);
  return `${m}:${sec.padStart(6, '0')}`;
}

// In-place iterative radix-2 FFT.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j], ui = im[i + j];
        const vr = re[i + j + len / 2] * cwr - im[i + j + len / 2] * cwi;
        const vi = re[i + j + len / 2] * cwi + im[i + j + len / 2] * cwr;
        re[i + j] = ur + vr;
        im[i + j] = ui + vi;
        re[i + j + len / 2] = ur - vr;
        im[i + j + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
}

// Estimate the musical key: chromagram from FFT frames, correlated against
// the Krumhansl-Schmuckler major/minor profiles. Heuristic — most reliable
// on tonal material; drums/noise will produce low-confidence nonsense, so
// return null when correlation is weak.
function detectKey(channels, sampleRate) {
  const N = 4096;
  const maxFrames = Math.min(channels[0].length, sampleRate * 60);
  if (maxFrames < N) return null;
  const chroma = new Float64Array(12);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const L = channels[0];
  const R = channels[1];

  for (let start = 0; start + N <= maxFrames; start += N) {
    for (let i = 0; i < N; i++) {
      const v = R ? 0.5 * (L[start + i] + R[start + i]) : L[start + i];
      re[i] = v * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 1; k < N / 2; k++) {
      const freq = (k * sampleRate) / N;
      if (freq < 55 || freq > 4000) continue;
      const mag = Math.hypot(re[k], im[k]);
      const midi = 69 + 12 * Math.log2(freq / 440);
      const pc = ((Math.round(midi) % 12) + 12) % 12;
      chroma[pc] += mag;
    }
  }

  const MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const correlate = (profile, rot) => {
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < 12; i++) {
      const x = chroma[(i + rot) % 12];
      const y = profile[i];
      sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
    }
    const cov = sxy - (sx * sy) / 12;
    const den = Math.sqrt((sxx - (sx * sx) / 12) * (syy - (sy * sy) / 12));
    return den > 0 ? cov / den : 0;
  };

  let best = { score: -2, pc: 0, major: true };
  for (let pc = 0; pc < 12; pc++) {
    const cMaj = correlate(MAJ, pc);
    const cMin = correlate(MIN, pc);
    if (cMaj > best.score) best = { score: cMaj, pc, major: true };
    if (cMin > best.score) best = { score: cMin, pc, major: false };
  }
  if (best.score < 0.5) return null; // too ambiguous to claim a key
  return { pc: best.pc, major: best.major };
}

// Fundamental pitch via normalized autocorrelation over voiced frames; the
// median f0 becomes a note name with octave (e.g. "F2"). Works on monophonic
// material (bass lines, single hits); on chords it locks to the strongest
// periodicity. Returns null when nothing is reliably periodic.
function detectPitch(channels, sampleRate) {
  const L = channels[0];
  const R = channels[1];
  const frame = 2048;
  const hop = 4096;
  const minLag = Math.floor(sampleRate / 1000); // 1 kHz ceiling
  const maxLag = Math.floor(sampleRate / 50);   // 50 Hz floor
  const limit = Math.min(L.length - frame, sampleRate * 10);
  const buf = new Float64Array(frame);
  const f0s = [];

  for (let start = 0; start < limit; start += hop) {
    let rms = 0;
    for (let i = 0; i < frame; i++) {
      const v = R ? 0.5 * (L[start + i] + R[start + i]) : L[start + i];
      buf[i] = v;
      rms += v * v;
    }
    if (Math.sqrt(rms / frame) < 0.01) continue; // silence

    let bestLag = 0;
    let bestCorr = 0;
    for (let lag = minLag; lag <= maxLag && lag < frame; lag++) {
      let num = 0, den = 0;
      for (let i = 0; i < frame - lag; i++) {
        num += buf[i] * buf[i + lag];
        den += buf[i] * buf[i] + buf[i + lag] * buf[i + lag];
      }
      const corr = den > 0 ? (2 * num) / den : 0;
      if (corr > bestCorr) {
        bestCorr = corr;
        bestLag = lag;
      }
    }
    if (bestCorr > 0.85 && bestLag > 0) f0s.push(sampleRate / bestLag);
  }

  if (f0s.length === 0) return null;
  f0s.sort((a, b) => a - b);
  const f0 = f0s[Math.floor(f0s.length / 2)];
  return { midi: Math.round(69 + 12 * Math.log2(f0 / 440)) };
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Tempo detection: build an onset-strength envelope (positive energy rise per
// hop), autocorrelate it to find the dominant beat period, and fold into a
// musical range. Returns { bpm, phase } where phase is the first beat's time,
// or null when no clear pulse is found (e.g. pads, single hits). No manual
// tempo input needed.
function detectTempo(channels, sampleRate) {
  const L = channels[0];
  const R = channels[1];
  const hop = 512;
  const frame = 1024;
  const n = L.length;
  const envLen = Math.floor((n - frame) / hop);
  if (envLen < 16) return null;

  const env = new Float32Array(envLen);
  let prev = 0;
  for (let f = 0; f < envLen; f++) {
    const s = f * hop;
    let e = 0;
    for (let i = 0; i < frame; i++) {
      const v = R ? 0.5 * (L[s + i] + R[s + i]) : L[s + i];
      e += v * v;
    }
    e = Math.sqrt(e / frame);
    env[f] = Math.max(0, e - prev); // positive flux = onset strength
    prev = e;
  }

  const envRate = sampleRate / hop;
  const minBpm = 70, maxBpm = 190;
  const minLag = Math.max(1, Math.floor((60 / maxBpm) * envRate));
  const maxLag = Math.min(envLen - 1, Math.ceil((60 / minBpm) * envRate));
  if (maxLag <= minLag) return null;

  // Normalized autocorrelation (cosine similarity per lag) in [0,1] — robust
  // against both flat noise and near-silent envelopes (pads).
  const scores = [];
  let bestIdx = 0, bestScore = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let num = 0, e1 = 0, e2 = 0;
    for (let i = 0; i + lag < envLen; i++) {
      num += env[i] * env[i + lag];
      e1 += env[i] * env[i];
      e2 += env[i + lag] * env[i + lag];
    }
    const norm = e1 > 0 && e2 > 0 ? num / Math.sqrt(e1 * e2) : 0;
    const idx = scores.push(norm) - 1;
    if (norm > bestScore) { bestScore = norm; bestIdx = idx; }
  }
  // A clear pulse correlates strongly with itself a beat later; noise/pads do not.
  if (bestScore < 0.3) return null;

  // Parabolic interpolation around the peak for sub-frame lag accuracy.
  let bestLag = minLag + bestIdx;
  if (bestIdx > 0 && bestIdx < scores.length - 1) {
    const sm1 = scores[bestIdx - 1], s0 = scores[bestIdx], sp1 = scores[bestIdx + 1];
    const denom = sm1 - 2 * s0 + sp1;
    if (denom !== 0) bestLag += (0.5 * (sm1 - sp1)) / denom;
  }

  let bpm = (60 * envRate) / bestLag;
  while (bpm < minBpm) bpm *= 2;
  while (bpm > maxBpm) bpm /= 2;

  // Phase: strongest onset within the first beat period.
  const beatFrames = Math.ceil((60 / bpm) * envRate);
  let phaseFrame = 0, mx = -1;
  for (let i = 0; i < Math.min(envLen, beatFrames); i++) {
    if (env[i] > mx) { mx = env[i]; phaseFrame = i; }
  }
  const phase = (phaseFrame * hop + frame / 2) / sampleRate;
  return { bpm, phase };
}

document.addEventListener('DOMContentLoaded', () => {
  let dialogClosed = false;
  function closeWithResultOnce(result) {
    if (dialogClosed) return;
    dialogClosed = true;
    closeWithResult(result);
  }

  // Wire every close affordance before anything that can fail — the dialog
  // must always be dismissable, even when waveform data is missing.
  const cancel = () => closeWithResultOnce({ cancelled: true });
  document.getElementById('btn-close').addEventListener('click', cancel);
  document.getElementById('close-label').addEventListener('click', cancel);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cancel();
  });

  const data = window.WAVEFORM_DATA;
  if (!data) {
    document.getElementById('file-name').textContent = 'Error: no waveform data';
    return;
  }

  document.getElementById('file-name').textContent = data.fileName;
  document.getElementById('duration-label').textContent =
    `${data.sampleRate / 1000}kHz · ${data.channels === 1 ? 'Mono' : 'Stereo'} · ${fmtTime(data.duration)}`;
  document.getElementById('time-start').textContent = fmtTime(0);
  document.getElementById('time-end').textContent = fmtTime(data.duration);

  // Rename — right-click the filename to edit it inline. The renamed stem is
  // sent with Process/Copy so the output file (and Live clip) uses it.
  let customStem = '';
  const fileNameEl = document.getElementById('file-name');
  const origStem = data.fileName.replace(/\.[^.]+$/, '');
  // Processed output is always .wav, so a renamed sample shows ".wav".
  const renderFileName = () => {
    fileNameEl.textContent = customStem ? `${customStem}.wav` : data.fileName;
  };
  const startRename = () => {
    fileNameEl.classList.add('editing');
    fileNameEl.setAttribute('contenteditable', 'true');
    fileNameEl.textContent = customStem || origStem;
    const range = document.createRange();
    range.selectNodeContents(fileNameEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    fileNameEl.focus();
  };
  const endRename = (commit) => {
    if (commit) {
      const v = fileNameEl.textContent.replace(/[\/\\:*?"<>|\n\r\t]/g, '').trim();
      customStem = v;
    }
    fileNameEl.classList.remove('editing');
    fileNameEl.removeAttribute('contenteditable');
    renderFileName();
  };
  fileNameEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    startRename();
  });
  fileNameEl.addEventListener('keydown', (e) => {
    if (fileNameEl.getAttribute('contenteditable') !== 'true') return;
    e.stopPropagation(); // keep space/arrows/Escape off transport + close
    if (e.key === 'Enter') { e.preventDefault(); endRename(true); fileNameEl.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); endRename(false); fileNameEl.blur(); }
  });
  fileNameEl.addEventListener('blur', () => {
    if (fileNameEl.getAttribute('contenteditable') === 'true') endRename(true);
  });

  const container = document.getElementById('waveform-container');
  const canvas = document.getElementById('waveform-canvas');
  const waveform = new window.WaveformCanvas(canvas, container);
  waveform.load(data);

  // Keyboard transport: space toggles preview; ←/→ scroll the view to the
  // start/end without moving the playhead.
  document.addEventListener('keydown', (e) => {
    const isSpace = e.code === 'Space';
    const isArrow = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
    if (!isSpace && !isArrow) return;
    // Focused controls capture space/arrows — release so keys always mean
    // transport.
    if (e.target instanceof HTMLElement
      && (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON')) {
      e.target.blur();
    }
    e.preventDefault();
    if (isSpace) {
      if (previewSrc) {
        stopPreview();
      } else {
        startPreview().catch((err) => console.error('[Audio Editor] preview', err));
      }
      return;
    }
    if (!waveform.data) return;
    // Scroll the view to the selection start (←) or end (→), parked slightly
    // in from the viewport edge.
    const t = e.key === 'ArrowLeft' ? waveform.trimStart : waveform.trimEnd;
    const px = (t / waveform.data.duration) * waveform._totalWidth();
    const margin = waveform.canvas.width * (e.key === 'ArrowLeft' ? 0.1 : 0.9);
    waveform.scrollX = px - margin;
    waveform._clampScroll();
    waveform.draw();
  });

  // Zoom controls — slider is logarithmic across 1×..maxZoom (sample level)
  const zoomSlider = document.getElementById('zoom-slider');
  const sliderToZoom = (v) => {
    const max = Number(zoomSlider.max) || 100;
    return Math.pow(waveform.maxZoom, (v - 1) / (max - 1));
  };
  zoomSlider.addEventListener('input', () => waveform.setZoom(sliderToZoom(Number(zoomSlider.value))));
  for (const id of ['bars-select', 'beats-select']) {
    const sel = document.getElementById(id);
    sel.addEventListener('change', () => {
      sel.blur(); // keep space/arrows on transport duty
      // The user has asserted the bar/beat count: hand the BPM and grid back to
      // bars × beats, stepping the detected tempo aside until the next load.
      waveform.manualTempo = true;
      waveform.draw();
      updateStretchUi(); // bar/beat count changes the current BPM, so the ratio too
    });
  }

  // Timestretch to target BPM (pitch-preserving WSOLA, loop-safe).
  let stretchOn = false;
  const btnStretch = document.getElementById('btn-stretch');
  const targetBpmInput = document.getElementById('target-bpm');
  let stretchCache = { key: '', buffer: null };

  function currentBpm() {
    // Prefer the detected tempo (no manual entry needed); fall back to the
    // bars × beats over the selection length once the user takes manual control.
    if (waveform.autoBpm) {
      return waveform.autoBpm;
    }
    const bars = Number(document.getElementById('bars-select').value) || 1;
    const beats = Number(document.getElementById('beats-select').value) || 4;
    const len = waveform.trimEnd - waveform.trimStart;
    return len > 0 ? (bars * beats * 60) / len : 0;
  }

  function stretchRatio() {
    if (!stretchOn) return 1;
    const target = Number(targetBpmInput.value);
    const cur = currentBpm();
    if (!target || target < 20 || target > 999 || !cur) return 1;
    return cur / target; // slower target -> longer audio
  }

  // Pitch / granular-character controls (apply to preview, Process and Copy).
  const pitchInput = document.getElementById('pitch-input');
  const windowInput = document.getElementById('window-input');
  const transientInput = document.getElementById('transient-input');
  const pitchSemitones = () => Math.max(-24, Math.min(24, Number(pitchInput.value) || 0));
  const stretchWindowMs = () => Math.max(2, Math.min(120, Number(windowInput.value) || 48));
  const stretchTransient = () => Math.max(0, Math.min(1, (Number(transientInput.value) || 0) / 100));
  for (const el of [pitchInput, windowInput, transientInput]) {
    el.addEventListener('input', () => {
      stretchCache.key = ''; // invalidate cached granular preview
      stopPreview();
    });
  }
  // Pitch shifts transpose the detected key/note — re-render the label live.
  pitchInput.addEventListener('input', () => renderKeyLabel());

  function updateStretchUi() {
    if (!stretchOn) {
      btnStretch.textContent = 'Stretch: OFF';
      btnStretch.style.background = '';
      btnStretch.style.color = '';
      targetBpmInput.style.borderColor = '';
      return;
    }
    btnStretch.style.background = 'hsl(200,80%,40%)';
    btnStretch.style.color = '#fff';
    const r = stretchRatio();
    if (r === 1) {
      // No usable target BPM — say so instead of silently doing nothing.
      btnStretch.textContent = 'Stretch: set BPM →';
      targetBpmInput.style.borderColor = 'hsl(0,80%,60%)';
    } else {
      btnStretch.textContent = `Stretch: ×${r.toFixed(3)}`;
      targetBpmInput.style.borderColor = '';
    }
  }

  btnStretch.addEventListener('click', () => {
    stretchOn = !stretchOn;
    btnStretch.blur();
    const target = Number(targetBpmInput.value);
    if (stretchOn && !(target >= 20 && target <= 999)) {
      targetBpmInput.focus();
    }
    stopPreview();
    updateStretchUi();
  });

  targetBpmInput.addEventListener('input', () => {
    stopPreview();
    updateStretchUi();
  });
  document.getElementById('zoom-btn-minus').addEventListener('click', () => {
    waveform.setZoom(waveform.zoom / 1.5);
  });
  document.getElementById('zoom-btn-plus').addEventListener('click', () => {
    waveform.setZoom(waveform.zoom * 1.5);
  });
  document.getElementById('zoom-btn-sel').addEventListener('click', () => {
    waveform.zoomToSelection();
  });
  document.getElementById('zoom-btn-fit').addEventListener('click', () => {
    waveform.setZoom(1);
    waveform.scrollX = 0;
    waveform.draw();
  });

  // Gain
  const gainSlider = document.getElementById('gain-slider');
  const gainValue = document.getElementById('gain-value');
  gainSlider.addEventListener('input', () => {
    const db = Number(gainSlider.value);
    gainValue.textContent = `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
    waveform.setGain(db);
    if (previewGain) previewGain.gain.value = Math.pow(10, db / 20);
  });

  // Channel buttons — only meaningful for stereo sources; hide the row for mono.
  let selectedChannel = 'stereo';
  if (data.channels === 1) {
    document.getElementById('channel-row').style.display = 'none';
  }
  const channelBtns = document.querySelectorAll('.channel-btn');
  channelBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      channelBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedChannel = btn.dataset.ch;
      waveform.setChannelMode(selectedChannel);
      stopPreview();
    });
  });

  // Preview — plays the current selection (trim, gain, channel) via Web Audio.
  const btnPreview = document.getElementById('btn-preview');
  let audioCtx = null;
  let decodedBuffer = null;
  let decodePromise = null;
  let previewSrc = null;
  let previewGain = null;
  let playheadRaf = 0;

  function ensureAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }

  // Lazily decode the rendered audio, cached after the first call. The bytes
  // arrive in a SEPARATE script file (window.AUDIO_WAV_B64) loaded after the UI
  // markup, so the modal paints before this runs — a long clip is tens of MB and,
  // when it was inlined ahead of the UI, left the webview blank until a restart
  // (issue #1). file: URLs are fetched as a script subresource (allowed) rather
  // than via fetch()/XHR (blocked cross-origin in the modal webview).
  async function getDecodedBuffer() {
    if (decodedBuffer) return decodedBuffer;
    if (decodePromise) return decodePromise;
    decodePromise = (async () => {
      if (!window.AUDIO_WAV_B64) {
        console.error(window.AUDIO_WAV_LOAD_FAILED
          ? '[clip-tool] audio data subresource failed to load — preview unavailable'
          : '[clip-tool] audio data not yet available');
        return null;
      }
      const ctx = ensureAudioCtx();
      const raw = atob(window.AUDIO_WAV_B64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      decodedBuffer = await ctx.decodeAudioData(bytes.buffer);
      return decodedBuffer;
    })().catch((err) => {
      // Clear the cached promise so a transient decode failure can be retried
      // on the next call instead of disabling preview for the whole session.
      decodePromise = null;
      console.error('[clip-tool] audio decode failed:', err);
      return null;
    });
    return decodePromise;
  }

  // Red activity LED — lit during preview playback and process/copy actions.
  const ledEl = document.getElementById('led');
  function setLed(on) { if (ledEl) ledEl.classList.toggle('on', on); }

  function stopPreview() {
    cancelAnimationFrame(playheadRaf);
    if (previewSrc) {
      previewSrc.onended = null;
      try { previewSrc.stop(); } catch { /* already stopped */ }
      previewSrc = null;
    }
    btnPreview.textContent = '▶ Preview';
    setLed(false);
  }

  function buildPreviewBuffer(buffer, mode) {
    let out;
    if (mode === 'stereo') {
      // Copy so fades can be applied without mutating the decoded master.
      out = audioCtx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        out.copyToChannel(buffer.getChannelData(c), c);
      }
    } else {
      const left = buffer.getChannelData(0);
      const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
      out = audioCtx.createBuffer(1, buffer.length, buffer.sampleRate);
      const d = out.getChannelData(0);
      for (let i = 0; i < buffer.length; i++) {
        if (mode === 'left') d[i] = left[i];
        else if (mode === 'right') d[i] = right[i];
        else if (mode === 'mixed') d[i] = 0.5 * left[i] + 0.5 * right[i];
        else d[i] = 0.5 * left[i] - 0.5 * right[i]; // side
      }
    }
    applyPreviewDc(out);
    applyPreviewFades(out);
    return out;
  }

  // Remove DC offset per channel — mirrors the processor (before gain/fades).
  function applyPreviewDc(buffer) {
    if (!dcEnabled) return;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = buffer.getChannelData(c);
      let sum = 0;
      for (let i = 0; i < d.length; i++) sum += d[i];
      const mean = sum / d.length;
      if (mean !== 0) for (let i = 0; i < d.length; i++) d[i] -= mean;
    }
  }

  // Apply the editor's fade envelopes at their on-screen anchors (the trim
  // region edges), using the same shared curve math as the processor.
  function applyPreviewFades(buffer) {
    const sr = buffer.sampleRate;
    for (const which of ['in', 'out']) {
      const { spec, len, t0 } = waveform._fadeRange(which);
      if (len <= 0) continue;
      const s = Math.max(0, Math.floor(t0 * sr));
      const n = Math.min(buffer.length - s, Math.round(len * sr));
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        const d = buffer.getChannelData(c);
        for (let i = 0; i < n; i++) {
          const p = i / n;
          d[s + i] *= window.Fades.fadeGain(which === 'in' ? p : 1 - p, spec.type, spec.bend);
        }
      }
    }
  }

  async function startPreview() {
    const buf = await getDecodedBuffer();
    if (!buf) return;
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    previewGain = audioCtx.createGain();
    previewGain.gain.value = Math.pow(10, Number(gainSlider.value) / 20);
    previewSrc = audioCtx.createBufferSource();
    previewSrc.connect(previewGain);
    previewGain.connect(audioCtx.destination);
    previewSrc.onended = stopPreview;
    setLed(true);

    // Stretched / pitched preview: render the selection at the target tempo
    // and/or pitch and play that, mapping the playhead back onto the region.
    // The unstretched full-buffer is only built on the plain path below.
    const ratio = stretchRatio();
    const pitch = pitchSemitones();
    if (ratio !== 1 || pitch !== 0) {
      // Stretch the selection (matches the BPM basis and the processor crop);
      // loop only governs cyclic seamlessness and whether preview cycles.
      const looped = waveform.hasLoop && loopEnabled;
      const segStart = waveform.trimStart;
      const segEnd = waveform.trimEnd;
      const sr = decodedBuffer.sampleRate;
      const f0 = Math.max(0, Math.floor(segStart * sr));
      const f1 = Math.min(decodedBuffer.length, Math.ceil(segEnd * sr));
      const fi = waveform.fadeIn;
      const fo = waveform.fadeOut;
      const win = stretchWindowMs();
      const trans = stretchTransient();
      const cacheKey = [
        f0, f1, ratio.toFixed(5), selectedChannel, looped,
        fi.len.toFixed(4), fi.type, fi.bend.toFixed(3),
        fo.len.toFixed(4), fo.type, fo.bend.toFixed(3),
        pitch, win, trans.toFixed(3),
      ].join(':');
      if (stretchCache.key !== cacheKey) {
        const base = buildPreviewBuffer(decodedBuffer, selectedChannel);
        const seg = [];
        for (let c = 0; c < base.numberOfChannels; c++) {
          seg.push(base.getChannelData(c).slice(f0, f1));
        }
        const stretched = await window.TimeStretch.stretchCyclic(seg, ratio, sr, looped, {
          pitch, windowMs: win, transient: trans,
        });
        const buf = audioCtx.createBuffer(stretched.length, stretched[0].length, sr);
        stretched.forEach((ch, c) => buf.copyToChannel(ch, c));
        stretchCache = { key: cacheKey, buffer: buf };
      }
      previewSrc.buffer = stretchCache.buffer;
      previewSrc.loop = looped;
      previewSrc.start(0);
      btnPreview.textContent = '■ Stop';

      const stretchedDur = stretchCache.buffer.duration;
      const st0 = audioCtx.currentTime;
      const animateStretched = () => {
        if (!previewSrc) return;
        let el = audioCtx.currentTime - st0;
        if (previewSrc.loop) el %= stretchedDur;
        else el = Math.min(el, stretchedDur);
        waveform.setPlayhead(segStart + (el / stretchedDur) * (segEnd - segStart));
        playheadRaf = requestAnimationFrame(animateStretched);
      };
      playheadRaf = requestAnimationFrame(animateStretched);
      return;
    }

    previewSrc.buffer = buildPreviewBuffer(decodedBuffer, selectedChannel);
    let start;
    if (waveform.hasLoop && loopEnabled) {
      // Loop playback: start from the playhead if it sits inside the loop,
      // else from loop start, and cycle until stopped.
      previewSrc.loop = true;
      previewSrc.loopStart = waveform.loopStart;
      previewSrc.loopEnd = waveform.loopEnd;
      start = waveform.playhead >= waveform.loopStart && waveform.playhead < waveform.loopEnd
        ? waveform.playhead
        : waveform.loopStart;
      previewSrc.start(0, start);
    } else {
      // Play from the playhead if it sits inside the trim region, else from
      // the region start; stop at the out point.
      start = Math.max(waveform.trimStart, Math.min(waveform.playhead, waveform.trimEnd));
      if (waveform.trimEnd - start < 0.01) start = waveform.trimStart;
      previewSrc.start(0, start, Math.max(0, waveform.trimEnd - start));
    }
    btnPreview.textContent = '■ Stop';

    const t0 = audioCtx.currentTime;
    const animate = () => {
      if (!previewSrc) return;
      let t = start + (audioCtx.currentTime - t0);
      if (previewSrc.loop && waveform.hasLoop) {
        // Track loop-point drags live, and wrap the playhead with the cycle.
        previewSrc.loopStart = waveform.loopStart;
        previewSrc.loopEnd = waveform.loopEnd;
        if (t > waveform.loopEnd) {
          const len = waveform.loopEnd - waveform.loopStart;
          t = waveform.loopStart + ((t - waveform.loopEnd) % len);
        }
      }
      waveform.setPlayhead(t);
      playheadRaf = requestAnimationFrame(animate);
    };
    playheadRaf = requestAnimationFrame(animate);
  }

  // Moving the playhead during playback restarts playback from the new position.
  waveform.onPlayheadSeek = () => {
    if (previewSrc) {
      stopPreview();
      startPreview().catch((e) => console.error('[Audio Editor] preview', e));
    }
  };

  // Right-click inside the trim selection: loop actions.
  const ctxMenu = document.getElementById('ctx-menu');
  const ctxLoopSel = document.getElementById('ctx-loop-sel');
  const ctxClearLoop = document.getElementById('ctx-clear-loop');

  function hideCtxMenu() {
    ctxMenu.style.display = 'none';
  }

  const fadeItems = document.querySelectorAll('.fade-item');
  const ctxClearFade = document.getElementById('ctx-clear-fade');
  const ctxClearSel = document.getElementById('ctx-clear-sel');
  let fadeMenuTarget = null; // 'in' | 'out' while the fade menu is open

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const t = waveform._xToTime(e.offsetX);
    if (t < waveform.trimStart || t > waveform.trimEnd) {
      hideCtxMenu();
      return;
    }

    // Inside a fade region → curve menu; elsewhere in the selection → loop menu.
    const fin = waveform._fadeRange('in');
    const fout = waveform._fadeRange('out');
    if (fin.len > 0 && t >= fin.t0 && t <= fin.t1) fadeMenuTarget = 'in';
    else if (fout.len > 0 && t >= fout.t0 && t <= fout.t1) fadeMenuTarget = 'out';
    else fadeMenuTarget = null;

    const showFade = fadeMenuTarget !== null;
    ctxLoopSel.style.display = showFade ? 'none' : 'block';
    ctxClearSel.style.display = showFade ? 'none' : 'block';
    ctxClearLoop.style.display = !showFade && waveform.hasLoop ? 'block' : 'none';
    fadeItems.forEach((el) => { el.style.display = showFade ? 'block' : 'none'; });
    ctxClearFade.style.display = showFade ? 'block' : 'none';

    ctxMenu.style.left = `${e.clientX}px`;
    ctxMenu.style.top = `${e.clientY}px`;
    ctxMenu.style.display = 'block';
  });

  fadeItems.forEach((el) => {
    el.addEventListener('click', () => {
      if (fadeMenuTarget) {
        const spec = fadeMenuTarget === 'in' ? waveform.fadeIn : waveform.fadeOut;
        spec.type = el.dataset.curve;
        spec.bend = 0;
        waveform.draw();
      }
      hideCtxMenu();
    });
  });

  ctxClearFade.addEventListener('click', () => {
    if (fadeMenuTarget) {
      const spec = fadeMenuTarget === 'in' ? waveform.fadeIn : waveform.fadeOut;
      spec.len = 0;
      spec.bend = 0;
      waveform.draw();
    }
    hideCtxMenu();
  });

  document.addEventListener('mousedown', (e) => {
    if (!ctxMenu.contains(e.target)) hideCtxMenu();
  });

  ctxLoopSel.addEventListener('click', () => {
    stopPreview();
    waveform.setLoop(waveform.trimStart, waveform.trimEnd);
    setLoopEnabled(true);
    hideCtxMenu();
  });

  ctxClearLoop.addEventListener('click', () => {
    stopPreview();
    waveform.clearLoop();
    setLoopEnabled(false);
    hideCtxMenu();
  });

  ctxClearSel.addEventListener('click', () => {
    stopPreview();
    // Reset the selection to span the whole current view.
    waveform.trimStart = 0;
    waveform.trimEnd = waveform.data.duration;
    waveform.draw();
    waveform._updateTrimInfo();
    hideCtxMenu();
  });

  // Decode the embedded audio up front: preview starts instantly and the
  // waveform can render true samples at deep zoom.
  (async () => {
    try {
      const buf = await getDecodedBuffer();
      if (!buf) return;
      const chans = [];
      for (let c = 0; c < buf.numberOfChannels; c++) {
        chans.push(buf.getChannelData(c));
      }
      waveform.setSampleData(chans);
      updateKeyLabel(chans, buf.sampleRate);
    } catch (e) {
      console.error('[Audio Editor] audio decode', e);
    }
  })();

  // Detected key/note are kept raw and re-rendered transposed by the current
  // pitch shift, so the label tracks the pitched result without re-analysis.
  let analysisKey = null;  // { pc, major } | null
  let analysisNote = null; // { midi } | null
  function renderKeyLabel() {
    const off = pitchSemitones();
    let note = '', key = '';
    if (analysisNote) {
      const m = analysisNote.midi + off;
      note = `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
    }
    if (analysisKey) {
      const pc = (((analysisKey.pc + off) % 12) + 12) % 12;
      key = `${NOTE_NAMES[pc]} ${analysisKey.major ? 'major' : 'minor'}`;
    }
    let txt = '';
    if (note && key) txt = `♪ ${note} · ${key}`;
    else if (key) txt = `♪ ${key}`;
    else if (note) txt = `♪ ${note}`;
    document.getElementById('key-label').textContent = txt;
  }

  function updateKeyLabel(chans, sampleRate) {
    // Defer a tick so the waveform paints before the analysis burns CPU.
    setTimeout(() => {
      try {
        analysisKey = detectKey(chans, sampleRate);    // scale (polyphonic)
        analysisNote = detectPitch(chans, sampleRate); // fundamental (monophonic)
        renderKeyLabel();
      } catch (e) {
        console.error('[Audio Editor] key detect', e);
      }
      try {
        // Detect tempo from the audio and drive the beat grid / BPM / stretch.
        const t = detectTempo(chans, sampleRate);
        waveform.detectedBpm = t ? t.bpm : null;
        waveform.beatPhase = t ? t.phase : 0;
        waveform.draw();
        updateStretchUi();
      } catch (e) {
        console.error('[Audio Editor] tempo detect', e);
      }
    }, 0);
  }

  btnPreview.addEventListener('click', () => {
    if (previewSrc) {
      stopPreview();
    } else {
      startPreview().catch((e) => console.error('[Audio Editor] preview', e));
    }
  });

  // Loop on/off — keeps the loop region, just toggles whether playback cycles.
  let loopEnabled = false;
  const btnLoop = document.getElementById('btn-loop');

  function setLoopEnabled(on) {
    loopEnabled = on;
    waveform.loopEnabled = on;
    btnLoop.textContent = on ? 'Loop: ON' : 'Loop: OFF';
    btnLoop.style.background = on ? 'hsl(200,80%,40%)' : '';
    btnLoop.style.color = on ? '#fff' : '';
    waveform.draw();
  }

  btnLoop.addEventListener('click', () => {
    const wasPlaying = !!previewSrc;
    if (!loopEnabled && !waveform.hasLoop) {
      // No loop region yet: create one from the current selection.
      waveform.setLoop(waveform.trimStart, waveform.trimEnd);
    }
    setLoopEnabled(!loopEnabled);
    stopPreview();
    if (wasPlaying) {
      startPreview().catch((e) => console.error('[Audio Editor] preview', e));
    }
  });

  // ZC — snap start/end point edits to zero crossings.
  let zcEnabled = false;
  const btnZc = document.getElementById('btn-zc');
  btnZc.addEventListener('click', () => {
    zcEnabled = !zcEnabled;
    waveform.snapZC = zcEnabled;
    btnZc.style.background = zcEnabled ? 'hsl(200,80%,40%)' : '';
    btnZc.style.color = zcEnabled ? '#fff' : '';
    if (zcEnabled) {
      // Snap the current points immediately.
      waveform.trimStart = Math.min(waveform._snapToZC(waveform.trimStart), waveform.trimEnd - 0.001);
      waveform.trimEnd = Math.max(waveform._snapToZC(waveform.trimEnd), waveform.trimStart + 0.001);
      if (waveform.hasLoop) {
        waveform.loopStart = Math.min(waveform._snapToZC(waveform.loopStart), waveform.loopEnd - 0.001);
        waveform.loopEnd = Math.max(waveform._snapToZC(waveform.loopEnd), waveform.loopStart + 0.001);
      }
      waveform.draw();
      waveform._updateTrimInfo();
    }
  });

  // DC — remove DC offset; applied on Process / Copy and reflected in preview.
  let dcEnabled = false;
  const btnDc = document.getElementById('btn-dc');
  btnDc.addEventListener('click', () => {
    dcEnabled = !dcEnabled;
    btnDc.style.background = dcEnabled ? 'hsl(200,80%,40%)' : '';
    btnDc.style.color = dcEnabled ? '#fff' : '';
    btnDc.blur();
    stretchCache.key = ''; // invalidate cached stretched preview
    stopPreview();
  });

  // Clip Guard — scale the processed output down if it would exceed 0 dBFS.
  // On by default: a pre-FX render can be hotter than the post-FX sound, so the
  // result can clip even when the source did not. Applied on Process / Copy / Simpler.
  let clipGuardEnabled = true;
  const btnClipGuard = document.getElementById('btn-clipguard');
  const paintClipGuard = () => {
    btnClipGuard.style.background = clipGuardEnabled ? 'hsl(200,80%,40%)' : '';
    btnClipGuard.style.color = clipGuardEnabled ? '#fff' : '';
  };
  paintClipGuard();
  btnClipGuard.addEventListener('click', () => {
    clipGuardEnabled = !clipGuardEnabled;
    paintClipGuard();
    btnClipGuard.blur();
  });

  // Trim to Selection — narrows the working audio to the current selection.
  // viewOffset maps editor-local time back to the original rendered file so
  // the process step crops the right region.
  let viewOffset = 0;
  let currentDuration = data.duration;
  const originalDuration = data.duration;

  function computePeaks(channels, count) {
    const peaks = [];
    for (let c = 0; c < channels.length; c++) {
      const ch = channels[c];
      const blockSize = Math.max(1, Math.floor(ch.length / count));
      const chPeaks = [];
      for (let i = 0; i < count; i++) {
        const s = i * blockSize;
        const e = Math.min(s + blockSize, ch.length);
        let mn = 0, mx = 0;
        for (let j = s; j < e; j++) {
          const v = ch[j];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        chPeaks.push(mn, mx);
      }
      peaks.push(chPeaks);
    }
    return peaks;
  }

  document.getElementById('btn-trim').addEventListener('click', () => {
    if (!decodedBuffer) return;
    stopPreview();
    const selStart = waveform.trimStart;
    const selEnd = waveform.trimEnd;
    // Capture the loop so it can be remapped into the trimmed view below.
    const hadLoop = waveform.hasLoop;
    const oldLoopStart = waveform.loopStart;
    const oldLoopEnd = waveform.loopEnd;
    const sr = decodedBuffer.sampleRate;
    const f0 = Math.max(0, Math.floor(selStart * sr));
    const f1 = Math.min(decodedBuffer.length, Math.ceil(selEnd * sr));
    if (f1 - f0 < 16) return;

    const sliced = audioCtx.createBuffer(decodedBuffer.numberOfChannels, f1 - f0, sr);
    const chans = [];
    for (let c = 0; c < decodedBuffer.numberOfChannels; c++) {
      sliced.copyToChannel(decodedBuffer.getChannelData(c).subarray(f0, f1), c);
      chans.push(sliced.getChannelData(c));
    }
    decodedBuffer = sliced;
    viewOffset += selStart;
    currentDuration = (f1 - f0) / sr;

    waveform.clearLoop();
    waveform.load({
      peaks: computePeaks(chans, 2000),
      duration: currentDuration,
      sampleRate: sr,
      channels: data.channels,
      fileName: data.fileName,
    });
    waveform.setSampleData(chans);
    waveform.setChannelMode(selectedChannel);
    waveform.setPlayhead(0);
    // Zoom to fit the freshly trimmed view.
    waveform.scrollX = 0;
    waveform.setZoom(1);

    // Remap the loop into the trimmed view (shift by the new origin, clamp to
    // the new bounds); drop it only if it falls entirely outside.
    if (hadLoop) {
      const ns = Math.max(0, oldLoopStart - selStart);
      const ne = Math.min(currentDuration, oldLoopEnd - selStart);
      if (ne - ns > 0.01) waveform.setLoop(ns, ne);
      else setLoopEnabled(false);
    }

    document.getElementById('time-end').textContent = fmtTime(currentDuration);
    waveform._updateTrimInfo();
    updateKeyLabel(chans, sr);
  });

  // True once the working view has been narrowed by Trim to Selection: either
  // its origin moved along the original render (viewOffset) or its length shrank.
  // The backend always renders from the original file, so Process/Copy/Simpler
  // must crop it back to this view — even with no active loop — or the trim is
  // silently discarded.
  const TRIM_EPS = 1e-6;
  const hasTrimmedView = () =>
    viewOffset > TRIM_EPS || currentDuration < originalDuration - TRIM_EPS;

  // Process — replaces the original clip. Editor-local times map back through
  // viewOffset. To cut a sample down, use Trim to Selection (which narrows the
  // working view); Process then renders that view. Fades also force a crop to
  // the selection, since they are anchored to its edges.
  document.getElementById('btn-process').addEventListener('click', () => {
    setLed(true);
    const hasFades = !!(fadeResult('in') || fadeResult('out'));
    const hasExplicitSelection = waveform.hasLoop && loopEnabled;
    let crop, trimStart, trimEnd;
    if (hasFades || hasExplicitSelection || hasTrimmedView()) {
      crop = true;
      trimStart = viewOffset + waveform.trimStart;
      trimEnd = viewOffset + waveform.trimEnd;
    } else {
      crop = false;
      trimStart = waveform.trimStart;
      trimEnd = waveform.trimEnd;
    }
    closeWithResultOnce({
      cancelled: false,
      mode: 'replace',
      trimStart,
      trimEnd,
      gain_dB: Number(gainSlider.value),
      channel: selectedChannel,
      crop,
      stretchRatio: stretchRatio(),
      stretchCyclic: !!(waveform.hasLoop && loopEnabled),
      fadeIn: fadeResult('in'),
      fadeOut: fadeResult('out'),
      removeDc: dcEnabled,
      preventClipping: clipGuardEnabled,
      pitchSemitones: pitchSemitones(),
      stretchWindowMs: stretchWindowMs(),
      stretchTransient: stretchTransient(),
      outputName: customStem,
    });
  });

  // Copy to Arrangement — renders the trim selection as a new clip after the
  // original, leaving the original in place. Only crops if explicitly selected via loop.
  document.getElementById('btn-copy').addEventListener('click', () => {
    setLed(true);
    const copyHasExplicitSelection = waveform.hasLoop && loopEnabled;
    closeWithResultOnce({
      cancelled: false,
      mode: 'copy',
      trimStart: viewOffset + waveform.trimStart,
      trimEnd: viewOffset + waveform.trimEnd,
      gain_dB: Number(gainSlider.value),
      channel: selectedChannel,
      crop: copyHasExplicitSelection || hasTrimmedView(),
      stretchRatio: stretchRatio(),
      stretchCyclic: !!(waveform.hasLoop && loopEnabled),
      fadeIn: fadeResult('in'),
      fadeOut: fadeResult('out'),
      removeDc: dcEnabled,
      preventClipping: clipGuardEnabled,
      pitchSemitones: pitchSemitones(),
      stretchWindowMs: stretchWindowMs(),
      stretchTransient: stretchTransient(),
      outputName: customStem,
    });
  });

  // Simpler — process the selection and drop it onto a Simpler on a new track.
  document.getElementById('btn-simpler').addEventListener('click', () => {
    setLed(true);
    const simplerHasExplicitSelection = waveform.hasLoop && loopEnabled;
    closeWithResultOnce({
      cancelled: false,
      mode: 'simpler',
      trimStart: viewOffset + waveform.trimStart,
      trimEnd: viewOffset + waveform.trimEnd,
      gain_dB: Number(gainSlider.value),
      channel: selectedChannel,
      crop: simplerHasExplicitSelection || hasTrimmedView(),
      stretchRatio: stretchRatio(),
      stretchCyclic: !!(waveform.hasLoop && loopEnabled),
      fadeIn: fadeResult('in'),
      fadeOut: fadeResult('out'),
      removeDc: dcEnabled,
      preventClipping: clipGuardEnabled,
      pitchSemitones: pitchSemitones(),
      stretchWindowMs: stretchWindowMs(),
      stretchTransient: stretchTransient(),
      outputName: customStem,
    });
  });

  // Fades are anchored to the selection edges in the editor; the processed
  // output starts/ends there too (crop or trimmed view), so only the clamped
  // length and shape need to travel.
  function fadeResult(which) {
    const { spec, len } = waveform._fadeRange(which);
    if (len <= 0) return null;
    return { len, type: spec.type, bend: spec.bend };
  }
});

// Themed dropdowns + number steppers — plain DOM (no eval/framework), so they
// work inside Live's hardened modal webview. Each binds to a hidden native
// control that stays the state source, dispatching change/input so the rest of
// controls.js reacts exactly as it would to keyboard entry.
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.sel[data-for]').forEach((box) => {
    const sel = document.getElementById(box.dataset.for);
    if (!sel) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sel-btn';
    btn.setAttribute('aria-label', box.dataset.label || box.dataset.for);
    const menu = document.createElement('ul');
    menu.className = 'sel-menu';
    const sync = () => {
      btn.textContent = sel.value + ' ▾';
      menu.querySelectorAll('.sel-opt').forEach((o) =>
        o.classList.toggle('sel-active', o.dataset.val === sel.value));
    };
    Array.from(sel.options).forEach((opt) => {
      const li = document.createElement('li');
      li.className = 'sel-opt';
      li.dataset.val = opt.value;
      li.textContent = opt.value;
      li.addEventListener('click', () => {
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        sync();
        menu.classList.remove('open');
      });
      menu.appendChild(li);
    });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = menu.classList.contains('open');
      document.querySelectorAll('.sel-menu.open').forEach((m) => m.classList.remove('open'));
      if (!open) menu.classList.add('open');
    });
    sel.addEventListener('change', sync);
    box.append(btn, menu);
    sync();
  });
  document.addEventListener('click', () =>
    document.querySelectorAll('.sel-menu.open').forEach((m) => m.classList.remove('open')));

  document.querySelectorAll('.num[data-for]').forEach((box) => {
    const input = document.getElementById(box.dataset.for);
    if (!input) return;
    const stepBy = (dir) => {
      const step = parseFloat(input.step) || 1;
      const min = input.min !== '' ? parseFloat(input.min) : -Infinity;
      const max = input.max !== '' ? parseFloat(input.max) : Infinity;
      const cur = parseFloat(input.value);
      const base = Number.isNaN(cur) ? (min === -Infinity ? 0 : min) : cur;
      const v = Math.min(max, Math.max(min, base + dir * step));
      const decimals = (String(step).split('.')[1] || '').length;
      input.value = String(parseFloat(v.toFixed(decimals)));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const up = box.querySelector('.num-up');
    const down = box.querySelector('.num-down');
    if (up) up.addEventListener('click', () => stepBy(1));
    if (down) down.addEventListener('click', () => stepBy(-1));
  });
});
