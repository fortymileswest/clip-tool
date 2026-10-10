import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vm from 'node:vm';

// waveform.js is a plain browser script that defines window.WaveformCanvas.
// Load it into a bare context and drive the methods that need no DOM.
function loadWaveformClass(): any {
  const src = fs.readFileSync(new URL('../src/webview/waveform.js', import.meta.url), 'utf-8');
  const sandbox: { window: Record<string, unknown> } = { window: {} };
  vm.runInNewContext(src, sandbox);
  return sandbox.window.WaveformCanvas;
}

const WaveformCanvas = loadWaveformClass();

/** A stand-in `this` with just the state setSampleData/_snapToZC touch. */
function fakeView(fileRate: number, duration: number) {
  const view = Object.create(WaveformCanvas.prototype);
  view.canvas = { width: 960 };
  view.width = 960;
  view.channelMode = 'stereo';
  view.removeDc = false;
  view.data = { sampleRate: fileRate, duration, peaks: [[0, 0]] };
  // The real setChannelMode also redraws; keep just its sample derivation.
  view.draw = () => {};
  view.displayPeaks = null;
  return view;
}

/** One zero crossing (negative -> positive) at sample index `at`. */
function stepSignal(n: number, at: number): Float32Array {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = i < at ? -0.5 : 0.5;
  return a;
}

test('snap to zero crossing uses the decoded buffer rate, not the file rate', () => {
  // A 44.1 kHz file decoded in a 48 kHz AudioContext: 1 s = 48000 samples.
  const view = fakeView(44100, 1);
  const crossing = 24000; // 0.5 s at 48 kHz
  view.setSampleData([stepSignal(48000, crossing)], 48000);
  const snapped = view._snapToZC(0.49);
  assert.ok(Math.abs(snapped - crossing / 48000) < 1e-9, `snapped to ${snapped}`);
});

test('without a decoded rate, the rate is derived from length and duration', () => {
  const view = fakeView(44100, 2);
  view.setSampleData([stepSignal(96000, 30000)], 0);
  assert.equal(view.samplesRate, 48000);
  assert.ok(Math.abs(view._snapToZC(0.6) - 30000 / 48000) < 1e-9);
});

test('max zoom keeps one decoded sample at about 8px', () => {
  const view = fakeView(44100, 1);
  view.setSampleData([new Float32Array(48000)], 48000);
  assert.equal(view.maxZoom, Math.ceil((48000 * 8) / 960));
});

test('no samples yet: snap returns the time unchanged', () => {
  const view = fakeView(44100, 1);
  view.samples = null;
  assert.equal(view._snapToZC(0.3), 0.3);
});

test('snap follows the channel mode: Side snaps on L−R, not the L+R mix', () => {
  const view = fakeView(48000, 1);
  // L+R crosses at 12000, L−R at 36000.
  const n = 48000;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const sum = i < 12000 ? -1 : 1;
    const diff = i < 36000 ? -1 : 1;
    L[i] = (sum + diff) / 2;
    R[i] = (sum - diff) / 2;
  }
  view.setSampleData([L, R], 48000);
  view.setChannelMode('side');
  assert.ok(Math.abs(view._snapToZC(0.74) - 36000 / 48000) < 1e-9);
  view.setChannelMode('mixed');
  assert.ok(Math.abs(view._snapToZC(0.26) - 12000 / 48000) < 1e-9);
});

test('with DC on, snap finds crossings of the DC-free signal', () => {
  const view = fakeView(48000, 1);
  // A step from 0.2 to 1.2: no raw crossing, but it crosses its mean (0.7).
  view.setSampleData([stepSignal(48000, 24000).map((v) => v + 0.7)], 48000);
  assert.equal(view._snapToZC(0.49), 0.49);
  view.removeDc = true;
  assert.ok(Math.abs(view._snapToZC(0.49) - 0.5) < 1e-9);
});
