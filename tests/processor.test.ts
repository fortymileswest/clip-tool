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

test('preventClipping scales a peak above 1.0 down to the ceiling', () => {
  // Gain pushes the 0.8 ramp peak above 1.0; the guard must pull it back.
  const input = [Float32Array.from([0.8, -0.8, 0.4, -0.4])];
  const out = processSamples(input, RATE, {
    ...BASE, channel: 'left', gain_dB: 6, preventClipping: true,
  });
  let peak = 0;
  for (const v of out[0]!) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak <= 1.0 + 1e-6, `peak should be <= 1.0, got ${peak}`);
  assert.ok(peak > 0.99, `peak should sit at the ceiling, got ${peak}`);
});

test('preventClipping scales uniformly, preserving waveform shape', () => {
  const input = [Float32Array.from([1.0, 0.5, -1.0, -0.25])];
  const out = processSamples(input, RATE, {
    ...BASE, channel: 'left', gain_dB: 6, preventClipping: true,
  });
  // Ratios between samples are unchanged after a single global scale.
  assert.ok(Math.abs(out[0]![1]! / out[0]![0]! - 0.5) < 1e-6);
  assert.ok(Math.abs(out[0]![3]! / out[0]![2]! - 0.25) < 1e-6);
});

test('preventClipping leaves sub-unity material untouched', () => {
  const input = [Float32Array.from([0.5, -0.5, 0.25])];
  const out = processSamples(input, RATE, {
    ...BASE, channel: 'left', preventClipping: true,
  });
  assert.deepEqual(Array.from(out[0]!), [0.5, -0.5, 0.25]);
});

test('preventClipping is global across channels, preserving stereo balance', () => {
  // Left peaks at 1.2 (clips), right at 0.6. One global factor 1/1.2 keeps the
  // 2:1 inter-channel ratio intact.
  const left = Float32Array.from([1.2, -0.6]);
  const right = Float32Array.from([0.6, -0.3]);
  const out = processSamples([left, right], RATE, {
    ...BASE, channel: 'stereo', preventClipping: true,
  });
  assert.ok(Math.abs(out[0]![0]! - 0.9999) < 1e-3, 'left peak at ceiling');
  assert.ok(Math.abs(out[0]![0]! / out[1]![0]! - 2) < 1e-6, '2:1 L/R ratio preserved');
});

test('preventClipping off (default) preserves overflow for float headroom', () => {
  const input = [Float32Array.from([0.8])];
  const out = processSamples(input, RATE, { ...BASE, channel: 'left', gain_dB: 6 });
  assert.ok(out[0]![0]! > 1.0, 'no guard means float can exceed 1.0');
});

test('processAudio reports progress incrementally with no dead-zone, incl. the stretch stage', async () => {
  const dir = os.tmpdir();
  const inputPath = path.join(dir, `audio-editor-prog-in-${process.pid}.wav`);
  const outputPath = path.join(dir, `audio-editor-prog-out-${process.pid}.wav`);

  // 1 second at 48k — long enough that decode, the pitch stretch, and encode
  // each emit several progress ticks.
  const frames = 48000;
  const ch = new Float32Array(frames);
  for (let i = 0; i < frames; i++) ch[i] = Math.sin((2 * Math.PI * 440 * i) / 48000);
  await encodeWavFile(inputPath, [ch], 48000);

  const seen: number[] = [];
  await processAudio(
    {
      inputPath,
      outputPath,
      gain_dB: 0,
      channel: 'left',
      crop: false,
      trimStart: 0,
      trimEnd: 1,
      pitchSemitones: 12, // forces the expensive WSOLA stretch stage
    },
    (p) => { seen.push(p); },
  );

  assert.ok(seen.length >= 6, `expected many progress ticks, got ${seen.length}`);
  // Monotonic non-decreasing.
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i]! >= seen[i - 1]! - 1e-9, `progress went backwards: ${seen[i - 1]} -> ${seen[i]}`);
  }
  // Ends at the top of the range.
  assert.ok(seen[seen.length - 1]! >= 0.99, `final progress ${seen[seen.length - 1]}`);
  // No dead-zone: the stretch stage (previously silent) must fill the middle, so
  // no gap between consecutive reported values exceeds a quarter of the bar.
  const sorted = [...seen].sort((a, b) => a - b);
  let maxGap = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) maxGap = Math.max(maxGap, sorted[i]! - sorted[i - 1]!);
  maxGap = Math.max(maxGap, 1 - sorted[sorted.length - 1]!);
  assert.ok(maxGap <= 0.25, `progress has a ${maxGap.toFixed(2)} dead-zone gap: ${sorted.map((v) => v.toFixed(2)).join(',')}`);
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
