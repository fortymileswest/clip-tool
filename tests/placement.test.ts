import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipDuration } from '../src/placement.ts';

test('nothing after the clip: the whole stretched result is shown', () => {
  assert.equal(clipDuration({ start: 8, naturalLength: 16, keepLength: 8, others: [{ start: 0, end: 4 }] }), undefined);
});

test('a result that fits before the next clip is shown in full', () => {
  assert.equal(clipDuration({ start: 8, naturalLength: 12, keepLength: 8, others: [{ start: 24, end: 32 }] }), undefined);
});

test('a stretch that would run into the next clip keeps the original size', () => {
  assert.equal(clipDuration({ start: 8, naturalLength: 16, keepLength: 8, others: [{ start: 16, end: 20 }] }), 8);
});

test('the kept size never overlaps a neighbour closer than the original length', () => {
  // A copy placed after the original, with a clip 2 beats later.
  assert.equal(clipDuration({ start: 8, naturalLength: 16, keepLength: 8, others: [{ start: 10, end: 12 }] }), 2);
});

test('a shorter result is always shown in full', () => {
  assert.equal(clipDuration({ start: 0, naturalLength: 4, keepLength: 8, others: [{ start: 8, end: 9 }] }), undefined);
});

test('clips before the start are ignored', () => {
  assert.equal(clipDuration({ start: 8, naturalLength: 16, keepLength: 8, others: [{ start: 2, end: 8 }] }), undefined);
});
