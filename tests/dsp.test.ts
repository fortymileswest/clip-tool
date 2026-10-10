import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePeaks } from '../src/dsp.ts';

test('computePeaks covers every sample whatever the length', () => {
  // 3087 samples into 2000 blocks: the old integer block size (1) left the
  // last 1087 samples out of the overview.
  const n = 3087;
  const ch = new Float32Array(n);
  ch[n - 1] = 0.9; // only the very last sample is loud
  const peaks = computePeaks([ch], 2000)[0]!;
  assert.equal(peaks.length, 4000);
  assert.equal(peaks[3999], ch[n - 1]); // max of the last block
});

test('computePeaks blocks line up with time: a mid-file spike lands mid-overview', () => {
  const n = 48000 * 3 + 1234;
  const ch = new Float32Array(n);
  ch[Math.floor(n / 2)] = 1;
  const peaks = computePeaks([ch], 2000)[0]!;
  const block = peaks.findIndex((v, i) => i % 2 === 1 && v === 1) / 2;
  assert.ok(Math.abs(block - 1000) <= 1, `spike in block ${block}`);
});

test('computePeaks handles clips shorter than the block count', () => {
  const peaks = computePeaks([new Float32Array([0.5, -0.5])], 4)[0]!;
  // Each sample shows in the blocks over its time: the first half, then the second.
  assert.deepEqual(peaks, [0, 0.5, 0, 0.5, -0.5, 0, -0.5, 0]);
});
