import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { clampStretchRatio, MIN_STRETCH, MAX_STRETCH } from '../src/editRange.ts';
import { processAudio } from '../src/processor.ts';
import { encodeWavFile } from '../src/wavEncoder.ts';
import { decodeWav } from '../src/wavDecoder.ts';

test('ratios inside the limits pass through untouched', () => {
  for (const r of [MIN_STRETCH, 0.5, 1, 1.25, 2, MAX_STRETCH]) {
    assert.deepEqual(clampStretchRatio(r), { ratio: r, limit: null });
  }
});

test('ratios outside the limits clamp and say which limit applied', () => {
  // e.g. 120 BPM clip, target typed as 12 instead of 120: ratio 10.
  assert.deepEqual(clampStretchRatio(10), { ratio: MAX_STRETCH, limit: 'max' });
  assert.deepEqual(clampStretchRatio(0.1), { ratio: MIN_STRETCH, limit: 'min' });
});

test('nonsense ratios mean no stretch', () => {
  for (const r of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(clampStretchRatio(r), { ratio: 1, limit: null });
  }
});

test('processAudio clamps an out-of-range ratio from any caller', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cliptool-stretch-'));
  try {
    const inputPath = path.join(dir, 'in.wav');
    const outputPath = path.join(dir, 'out.wav');
    const sr = 48000;
    const n = sr / 10; // 0.1 s
    const tone = new Float32Array(n);
    for (let i = 0; i < n; i++) tone[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr);
    await encodeWavFile(inputPath, [tone], sr);
    await processAudio({
      inputPath, outputPath, gain_dB: 0, channel: 'stereo', crop: false,
      trimStart: 0, trimEnd: 0.1, stretchRatio: 50,
    });
    const out = await decodeWav(outputPath);
    const ratio = out.getChannelData(0).length / n;
    assert.ok(Math.abs(ratio - MAX_STRETCH) < 0.05, `output is ${ratio.toFixed(3)}× the input`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
