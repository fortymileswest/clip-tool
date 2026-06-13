import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fadeGain, applyFades } from '../src/fades.ts';
import type { FadeType } from '../src/fades.ts';

const TYPES: FadeType[] = ['linear', 'exp', 'log', 's'];

test('fadeGain endpoints are 0 and 1 for every curve', () => {
  for (const type of TYPES) {
    for (const bend of [-1, -0.5, 0, 0.5, 1]) {
      assert.equal(fadeGain(0, type, bend), 0, `${type} bend ${bend} at 0`);
      assert.equal(fadeGain(1, type, bend), 1, `${type} bend ${bend} at 1`);
    }
  }
});

test('fadeGain is monotonically non-decreasing', () => {
  for (const type of TYPES) {
    for (const bend of [-1, 0, 1]) {
      let prev = -1;
      for (let i = 0; i <= 100; i++) {
        const g = fadeGain(i / 100, type, bend);
        assert.ok(g >= prev - 1e-9, `${type} bend ${bend} not monotonic at ${i / 100}`);
        prev = g;
      }
    }
  }
});

test('curve families are ordered at the midpoint: exp < linear < log', () => {
  const exp = fadeGain(0.5, 'exp', 0);
  const lin = fadeGain(0.5, 'linear', 0);
  const log = fadeGain(0.5, 'log', 0);
  assert.ok(exp < lin && lin < log, `${exp} < ${lin} < ${log}`);
});

test('bend warps the curve: positive lowers, negative raises the midpoint', () => {
  const base = fadeGain(0.5, 'linear', 0);
  assert.ok(fadeGain(0.5, 'linear', 0.8) < base);
  assert.ok(fadeGain(0.5, 'linear', -0.8) > base);
});

test('applyFades silences the very start and end', () => {
  const sr = 1000;
  const ch = new Float32Array(1000).fill(1);
  applyFades([ch], sr, { len: 0.1, type: 'linear', bend: 0 }, { len: 0.1, type: 'linear', bend: 0 });
  assert.equal(ch[0], 0, 'first sample silent');
  assert.ok(Math.abs(ch[999]!) < 0.02, `last sample ~silent, got ${ch[999]}`);
  assert.equal(ch[500], 1, 'middle untouched');
});

test('applyFades with no specs leaves audio untouched', () => {
  const ch = new Float32Array(100).fill(0.5);
  applyFades([ch], 1000, null, null);
  for (const v of ch) assert.equal(v, 0.5);
});
