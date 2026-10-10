// Standalone preview of the editor webview, for checking the look without
// Ableton Live. Run `npm run build` first, then `npm run preview`, and open
// preview/out/index.html in a browser.
//
// It assembles the modal page the same way extension.ts does, with a
// synthesised two-bar drum loop as the clip and a stubbed host bridge that
// logs messages to the console instead of closing a dialog. Nothing here is
// packaged into the extension (the package only takes dist/webview).

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { encodeWavFile } from '../src/wavEncoder.js';
import { loadAudioPeaks } from '../src/audioLoader.js';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'preview', 'out');
const dist = path.join(root, 'dist', 'webview');

// Deterministic noise so every run draws the same picture.
let seed = 0x2f6e2b1;
const noise = () => {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return ((seed >>> 0) / 0xffffffff) * 2 - 1;
};

function drumLoop(sampleRate: number, bpm: number, bars: number): Float32Array[] {
  const beat = 60 / bpm;
  const frames = Math.round(beat * 4 * bars * sampleRate);
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  const add = (t: number, fn: (dt: number) => [number, number], len: number) => {
    const i0 = Math.round(t * sampleRate);
    const n = Math.min(frames - i0, Math.round(len * sampleRate));
    for (let i = 0; i < n; i++) {
      const [l, r] = fn(i / sampleRate);
      L[i0 + i]! += l;
      R[i0 + i]! += r;
    }
  };
  const kick = (dt: number): [number, number] => {
    const f = 48 + 110 * Math.exp(-dt * 30);
    const v = Math.sin(2 * Math.PI * f * dt) * Math.exp(-dt * 7) * 0.95;
    return [v, v];
  };
  const snare = (dt: number): [number, number] => {
    const env = Math.exp(-dt * 16);
    const tone = Math.sin(2 * Math.PI * 190 * dt) * Math.exp(-dt * 30) * 0.4;
    return [(noise() * 0.55 + tone) * env, (noise() * 0.55 + tone) * env];
  };
  const hat = (dt: number): [number, number] => {
    const env = Math.exp(-dt * 60) * 0.22;
    return [noise() * env * 0.8, noise() * env];
  };
  // A break-ish pattern in eighths: K . H . S . H K | . K H . S . H .
  const pattern = ['K', 'H', 'S', 'H', 'KH', 'K', 'S', 'H'];
  for (let bar = 0; bar < bars; bar++) {
    pattern.forEach((hits, step) => {
      const t = (bar * 4 + step / 2) * beat;
      if (hits.includes('K')) add(t, kick, 0.6);
      if (hits.includes('S')) add(t, snare, 0.35);
      if (hits.includes('H')) add(t, hat, 0.12);
      add(t + beat / 2 * 0.98, hat, 0.08);
    });
  }
  return [L, R];
}

await fs.mkdir(outDir, { recursive: true });
const sampleRate = 44100;
const wavPath = path.join(outDir, 'demo-break.wav');
await encodeWavFile(wavPath, drumLoop(sampleRate, 120, 2), sampleRate);
const data = await loadAudioPeaks(wavPath);
data.fileName = 'Break 120.wav';

const b64 = (await fs.readFile(wavPath)).toString('base64');
await fs.writeFile(path.join(outDir, 'audio-data.js'), `window.AUDIO_WAV_B64="${b64}";`);

const [html, fontsCss, timestretchJs, fadesJs, editRangeJs, waveformJs, controlsJs] = await Promise.all([
  fs.readFile(path.join(root, 'src', 'webview', 'index.html'), 'utf-8'),
  fs.readFile(path.join(dist, 'fonts.css'), 'utf-8'),
  fs.readFile(path.join(dist, 'timestretch.js'), 'utf-8'),
  fs.readFile(path.join(dist, 'fades.js'), 'utf-8'),
  fs.readFile(path.join(dist, 'editrange.js'), 'utf-8'),
  fs.readFile(path.join(dist, 'waveform.js'), 'utf-8'),
  fs.readFile(path.join(dist, 'controls.js'), 'utf-8'),
]);

const hostStub = 'window.webkit = { messageHandlers: { live: { postMessage: (m) => console.log("[host]", m) } } };';
const page = html
  .replace('/* FONT_FACE_PLACEHOLDER */', fontsCss)
  .replace(
    '/* WAVEFORM_DATA_PLACEHOLDER */',
    `${hostStub}\nwindow.WAVEFORM_DATA = ${JSON.stringify(data).replace(/</g, '\\u003c')};`,
  )
  .replace(
    '<script src="timestretch.js"></script>',
    `<script src="audio-data.js"></script>\n<script>\n${timestretchJs}\n</script>`,
  )
  .replace('<script src="fades.js"></script>', `<script>\n${fadesJs}\n</script>`)
  .replace('<script src="editrange.js"></script>', `<script>\n${editRangeJs}\n</script>`)
  .replace('<script src="waveform.js"></script>', `<script>\n${waveformJs}\n</script>`)
  .replace('<script src="controls.js"></script>', `<script>\n${controlsJs}\n</script>`);
await fs.writeFile(path.join(outDir, 'index.html'), page);
console.log(`Preview written to ${path.relative(root, path.join(outDir, 'index.html'))}`);
