import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stretchCyclic } from '../src/timestretch.ts';

const SR = 44100;

function sine(freq: number, seconds: number): Float32Array {
  const n = Math.round(SR * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

function zeroCrossingsPerSecond(ch: Float32Array): number {
  let crossings = 0;
  for (let i = 1; i < ch.length; i++) {
    if ((ch[i - 1]! < 0 && ch[i]! >= 0) || (ch[i - 1]! > 0 && ch[i]! <= 0)) crossings++;
  }
  return crossings / (ch.length / SR);
}

test('ratio 1 returns a copy of the input', async () => {
  const input = sine(440, 1);
  const out = await stretchCyclic([input], 1, SR, false);
  assert.equal(out[0]!.length, input.length);
  assert.notEqual(out[0], input);
});

test('output length scales with the ratio', async () => {
  const input = sine(440, 2);
  for (const ratio of [0.5, 1.5, 2]) {
    const out = await stretchCyclic([input], ratio, SR, true);
    assert.equal(out[0]!.length, Math.round(input.length * ratio));
  }
});

test('pitch is preserved when stretching', async () => {
  const input = sine(440, 2);
  for (const ratio of [0.75, 1.5]) {
    const out = await stretchCyclic([input], ratio, SR, true);
    const zps = zeroCrossingsPerSecond(out[0]!);
    // 440Hz sine has ~880 crossings/sec; allow 5% for splice artifacts
    assert.ok(Math.abs(zps - 880) < 44, `ratio ${ratio}: ${zps} crossings/sec`);
  }
});

test('stereo channels stay aligned in length', async () => {
  const l = sine(220, 1);
  const r = sine(330, 1);
  const out = await stretchCyclic([l, r], 1.5, SR, true);
  assert.equal(out.length, 2);
  assert.equal(out[0]!.length, out[1]!.length);
});

test('pitch +12 semitones doubles frequency, keeps length', async () => {
  const input = sine(440, 2);
  const out = await stretchCyclic([input], 1, SR, false, { pitch: 12 });
  assert.equal(out[0]!.length, input.length); // ratio 1 → length unchanged
  const zps = zeroCrossingsPerSecond(out[0]!);
  // 440Hz → 880Hz ≈ 1760 crossings/sec; allow margin for granular artifacts
  assert.ok(Math.abs(zps - 1760) < 160, `got ${zps}`);
});

test('pitch -12 semitones halves frequency', async () => {
  const input = sine(440, 2);
  const out = await stretchCyclic([input], 1, SR, false, { pitch: -12 });
  assert.equal(out[0]!.length, input.length);
  const zps = zeroCrossingsPerSecond(out[0]!);
  // 440Hz → 220Hz ≈ 440 crossings/sec
  assert.ok(Math.abs(zps - 440) < 80, `got ${zps}`);
});

test('pitch + tempo stretch compose: length follows ratio, pitch shifts', async () => {
  const input = sine(440, 2);
  const out = await stretchCyclic([input], 1.5, SR, true, { pitch: 7 });
  assert.equal(out[0]!.length, Math.round(input.length * 1.5));
  const zps = zeroCrossingsPerSecond(out[0]!);
  const expected = 2 * 440 * Math.pow(2, 7 / 12); // crossings/sec at +7 st
  assert.ok(Math.abs(zps - expected) / expected < 0.08, `got ${zps}, expected ~${expected}`);
});

test('small window and transient params do not change length or blow up', async () => {
  const input = sine(330, 2);
  const out = await stretchCyclic([input], 1, SR, false, { pitch: 5, windowMs: 12, transient: 0.5 });
  assert.equal(out[0]!.length, input.length);
  let peak = 0;
  for (const v of out[0]!) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak <= 1.5, `peak ${peak}`);
});

test('cyclic stretch keeps levels sane at the loop seam', async () => {
  const input = sine(440, 1);
  const out = (await stretchCyclic([input], 1.5, SR, true))[0]!;
  // No silent gaps or blowups at either end of the cycle
  let maxAbs = 0;
  for (const v of out) maxAbs = Math.max(maxAbs, Math.abs(v));
  assert.ok(maxAbs <= 1.2, `peak ${maxAbs}`);
  const tail = out.subarray(out.length - 512);
  let tailRms = 0;
  for (const v of tail) tailRms += v * v;
  tailRms = Math.sqrt(tailRms / tail.length);
  assert.ok(tailRms > 0.1, `tail RMS ${tailRms} — seam should not be silent`);
});

function rms(ch: Float32Array, from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += ch[i]! * ch[i]!;
  return Math.sqrt(s / Math.max(1, to - from));
}

test('non-cyclic stretch and pitch-up keep the level right to the end', async () => {
  const input = sine(440, 1);
  const level = rms(input, 0, input.length); // ~0.707
  const cases: Array<[number, number]> = [[2, 0], [1.5, 0], [1, 12], [0.75, 7]];
  for (const [ratio, pitch] of cases) {
    const out = (await stretchCyclic([input], ratio, SR, false, { pitch }))[0]!;
    const tail = rms(out, out.length - Math.round(SR * 0.01), out.length);
    assert.ok(tail > level * 0.7, `ratio ${ratio} pitch ${pitch}: tail RMS ${tail.toFixed(3)} vs ${level.toFixed(3)}`);
  }
});

test('transient preservation leaves a steady tone at full level', async () => {
  const input = sine(440, 1);
  const level = rms(input, 0, input.length);
  for (const transient of [0.3, 0.7, 1]) {
    const out = (await stretchCyclic([input], 1.5, SR, false, { transient }))[0]!;
    const r = rms(out, Math.round(SR * 0.1), out.length - Math.round(SR * 0.1));
    assert.ok(Math.abs(r - level) / level < 0.1, `transient ${transient}: RMS ${r.toFixed(3)} vs ${level.toFixed(3)}`);
  }
});

test('transient preservation does not repeat attacks', async () => {
  // Four short decaying clicks, 250 ms apart, stretched 4×.
  const n = SR;
  const input = new Float32Array(n);
  for (let k = 0; k < 4; k++) {
    const at = Math.round(k * 0.25 * SR) + 1000;
    for (let i = 0; i < 400; i++) input[at + i] = Math.exp(-i / 60) * (i % 2 ? 1 : -1);
  }
  const out = (await stretchCyclic([input], 4, SR, false, { transient: 1 }))[0]!;
  // Count attacks: envelope rising above half the peak after being below 10%.
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const hop = Math.round(SR * 0.002);
  let bursts = 0, quiet = true;
  for (let i = 0; i + hop <= out.length; i += hop) {
    const e = rms(out, i, i + hop) * Math.SQRT2;
    if (quiet && e > peak * 0.3) { bursts++; quiet = false; }
    else if (!quiet && e < peak * 0.05) quiet = true;
  }
  assert.equal(bursts, 4, `expected 4 attacks, got ${bursts}`);
});

test('pitch-up never builds an intermediate buffer longer than the output', async () => {
  // Guarded indirectly: a +24 st, 4x stretch on 2 s finishes with exact length.
  const input = sine(220, 2);
  const out = await stretchCyclic([input], 4, SR, false, { pitch: 24 });
  assert.equal(out[0]!.length, Math.round(input.length * 4));
});
