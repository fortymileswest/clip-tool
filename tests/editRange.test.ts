import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRange, hasTrimmedView } from '../src/editRange.ts';
import type { RangeState } from '../src/editRange.ts';

const base: RangeState = {
  hasFades: false,
  hasExplicitSelection: false,
  viewOffset: 0,
  currentDuration: 10,
  originalDuration: 10,
  trimStart: 0,
  trimEnd: 10,
};

test('no fades, selection or trim: whole file, no crop', () => {
  assert.deepEqual(renderRange(base), { crop: false, trimStart: 0, trimEnd: 10 });
});

test('fades alone force a crop to the selection, so they sit where the preview plays them', () => {
  const r = renderRange({ ...base, hasFades: true, trimStart: 2, trimEnd: 6 });
  assert.deepEqual(r, { crop: true, trimStart: 2, trimEnd: 6 });
});

test('an enabled selection crops', () => {
  assert.equal(renderRange({ ...base, hasExplicitSelection: true, trimStart: 1, trimEnd: 3 }).crop, true);
});

test('a trimmed view crops and maps times back through viewOffset', () => {
  const s = { ...base, viewOffset: 4, currentDuration: 3, trimStart: 0.5, trimEnd: 2.5 };
  assert.equal(hasTrimmedView(s), true);
  assert.deepEqual(renderRange(s), { crop: true, trimStart: 4.5, trimEnd: 6.5 });
});

test('a view shortened from the end only still counts as trimmed', () => {
  assert.equal(hasTrimmedView({ viewOffset: 0, currentDuration: 9, originalDuration: 10 }), true);
  assert.equal(hasTrimmedView({ viewOffset: 1e-9, currentDuration: 10, originalDuration: 10 }), false);
});

test('every mode gets the same range for the same state', () => {
  // Process, Copy and Simpler all call renderRange with the same state; the
  // old Copy/Simpler paths ignored fades. Guard the fade case explicitly.
  for (const hasFades of [false, true]) {
    for (const hasExplicitSelection of [false, true]) {
      const r = renderRange({ ...base, hasFades, hasExplicitSelection, trimStart: 1, trimEnd: 5 });
      assert.equal(r.crop, hasFades || hasExplicitSelection);
    }
  }
});
