import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { processSamples, processAudio } from '../src/processor.ts';
import { encodeWavFile } from '../src/wavEncoder.ts';
import { decodeWav } from '../src/wavDecoder.ts';

const RATE = 1000; // 1kHz sample rate keeps frame math readable: 1 frame = 1ms

const BASE = {
  gain_dB: 0,
  channel: 'stereo' as const,
  crop: false,
  trimStart: 0,
  trimEnd: 4,
};

function stereoRamp(frames: number): Float32Array[] {
  // left counts up 0..frames-1 (scaled), right is the negation
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = i / frames;
    right[i] = -i / frames;
  }
  return [left, right];
}

test('stereo passthrough with no gain and no crop is identity', () => {
  const input = stereoRamp(100);
  const out = processSamples(input, RATE, BASE);
  assert.equal(out.length, 2);
  assert.deepEqual(Array.from(out[0]!), Array.from(input[0]!));
  assert.deepEqual(Array.from(out[1]!), Array.from(input[1]!));
});

test('crop trims to the requested sample range', () => {
  const input = stereoRamp(1000); // 1 second at RATE
  const out = processSamples(input, RATE, { ...BASE, crop: true, trimStart: 0.25, trimEnd: 0.75 });
  assert.equal(out[0]!.length, 500);
  assert.equal(out[0]![0], input[0]![250]);
  assert.equal(out[0]![499], input[0]![749]);
});

test('gain scales samples by 10^(dB/20)', () => {
  const input = [Float32Array.from([0.5, -0.5])];
  const out = processSamples(input, RATE, { ...BASE, gain_dB: 6 });
  const factor = Math.pow(10, 6 / 20);
  assert.ok(Math.abs(out[0]![0]! - 0.5 * factor) < 1e-6);
  assert.ok(Math.abs(out[0]![1]! - -0.5 * factor) < 1e-6);
});

test('left channel extracts c0 as mono', () => {
  const out = processSamples(stereoRamp(10), RATE, { ...BASE, channel: 'left' });
  assert.equal(out.length, 1);
  assert.ok(out[0]![5]! > 0, 'left ramp is positive');
});

test('right channel extracts c1 as mono', () => {
  const out = processSamples(stereoRamp(10), RATE, { ...BASE, channel: 'right' });
  assert.equal(out.length, 1);
  assert.ok(out[0]![5]! < 0, 'right ramp is negative');
});

test('mixed channel averages c0 and c1', () => {
  const out = processSamples(stereoRamp(10), RATE, { ...BASE, channel: 'mixed' });
  assert.equal(out.length, 1);
  // left and right are negations — mix cancels to silence
  for (const v of out[0]!) assert.ok(Math.abs(v) < 1e-6);
});

test('side channel is half the L/R difference', () => {
  const input = stereoRamp(10);
  const out = processSamples(input, RATE, { ...BASE, channel: 'side' });
  assert.equal(out.length, 1);
  for (let i = 0; i < 10; i++) {
    const expected = 0.5 * input[0]![i]! - 0.5 * input[1]![i]!;
    assert.ok(Math.abs(out[0]![i]! - expected) < 1e-6);
  }
});

test('mono input: right/mixed fall back to c0, side is silence', () => {
  const mono = [Float32Array.from([0.25, 0.5])];
  const right = processSamples(mono, RATE, { ...BASE, channel: 'right' });
  assert.deepEqual(Array.from(right[0]!), [0.25, 0.5]);
  const side = processSamples(mono, RATE, { ...BASE, channel: 'side' });
  assert.deepEqual(Array.from(side[0]!), [0, 0]);
});

test('crop + gain + channel combine', () => {
  const input = stereoRamp(1000);
  const out = processSamples(input, RATE, {
    crop: true, trimStart: 0.5, trimEnd: 1.0, gain_dB: -6, channel: 'left',
  });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.length, 500);
  const factor = Math.pow(10, -6 / 20);
  assert.ok(Math.abs(out[0]![0]! - input[0]![500]! * factor) < 1e-6);
});

test('removeDc subtracts the channel mean', () => {
  // Constant-offset signal: mean is the offset, so removal yields silence.
  const input = [Float32Array.from([0.3, 0.3, 0.3, 0.3])];
  const out = processSamples(input, RATE, { ...BASE, channel: 'left', removeDc: true });
  for (const v of out[0]!) assert.ok(Math.abs(v) < 1e-6, `expected ~0, got ${v}`);
});

test('removeDc preserves AC content, only shifts the mean to zero', () => {
  const input = [Float32Array.from([0.5, -0.5, 0.5, -0.5].map((v) => v + 0.2))];
  const out = processSamples(input, RATE, { ...BASE, channel: 'left', removeDc: true });
  let sum = 0;
  for (const v of out[0]!) sum += v;
  assert.ok(Math.abs(sum / out[0]!.length) < 1e-6, 'mean should be ~0');
  // Peak-to-peak preserved at 1.0
  assert.ok(Math.abs(Math.max(...out[0]!) - 0.5) < 1e-6);
  assert.ok(Math.abs(Math.min(...out[0]!) - -0.5) < 1e-6);
});

test('processing does not mutate the input buffers', () => {
  const input = [Float32Array.from([0.5])];
  processSamples(input, RATE, { ...BASE, gain_dB: 12, channel: 'left' });
  assert.equal(input[0]![0], 0.5);
});

test('trim bounds validation: trimStart < 0 throws', () => {
  assert.throws(
    () => processSamples(stereoRamp(10), RATE, { ...BASE, crop: true, trimStart: -1, trimEnd: 4 }),
    /trimStart must be >= 0/,
  );
});

test('trim bounds validation: trimStart >= trimEnd throws', () => {
  assert.throws(
    () => processSamples(stereoRamp(10), RATE, { ...BASE, crop: true, trimStart: 4, trimEnd: 4 }),
    /trimStart .* must be less than trimEnd/,
  );
});

test('trim bounds validation: no validation when crop=false', () => {
  assert.doesNotThrow(() =>
    processSamples(stereoRamp(10), RATE, { ...BASE, crop: false, trimStart: -1, trimEnd: -5 }),
  );
});

test('processAudio round-trips through WAV encode/decode', async () => {
  const dir = os.tmpdir();
  const inputPath = path.join(dir, `audio-editor-test-in-${process.pid}.wav`);
  const outputPath = path.join(dir, `audio-editor-test-out-${process.pid}.wav`);

  const frames = 4800;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = Math.sin((2 * Math.PI * 440 * i) / 48000);
    right[i] = Math.sin((2 * Math.PI * 220 * i) / 48000);
  }
  await encodeWavFile(inputPath, [left, right], 48000);

  await processAudio({
    inputPath,
    outputPath,
    gain_dB: -6,
    channel: 'left',
    crop: true,
    trimStart: 0.01,
    trimEnd: 0.05,
  });

  const result = await decodeWav(outputPath);
  assert.equal(result.numberOfChannels, 1);
  assert.equal(result.sampleRate, 48000);
  assert.equal(result.getChannelData(0).length, Math.round(0.04 * 48000));

  const factor = Math.pow(10, -6 / 20);
  const expected = left[480]! * factor;
  assert.ok(Math.abs(result.getChannelData(0)[0]! - expected) < 1e-6);
});
