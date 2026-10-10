import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { nextOutputPath, sanitizeOutputName, uniqueNamedPath } from '../src/projectPaths.ts';

test('nextOutputPath returns _edited_001 when no files exist', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ae-test-'));
  try {
    const result = await nextOutputPath(dir, 'kick');
    assert.equal(result, path.join(dir, 'kick_edited_001.wav'));
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});

test('nextOutputPath increments when _001 already exists', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ae-test-'));
  try {
    await fs.writeFile(path.join(dir, 'kick_edited_001.wav'), '');
    const result = await nextOutputPath(dir, 'kick');
    assert.equal(result, path.join(dir, 'kick_edited_002.wav'));
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});

test('nextOutputPath returns _003 when _001 and _002 already exist', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ae-test-'));
  try {
    await fs.writeFile(path.join(dir, 'kick_edited_001.wav'), '');
    await fs.writeFile(path.join(dir, 'kick_edited_002.wav'), '');
    const result = await nextOutputPath(dir, 'kick');
    assert.equal(result, path.join(dir, 'kick_edited_003.wav'));
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});

test('uniqueNamedPath uses the exact name when free', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ae-test-'));
  try {
    const result = await uniqueNamedPath(dir, 'My Loop');
    assert.equal(result, path.join(dir, 'My Loop.wav'));
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});

test('uniqueNamedPath appends _2 when the name is taken', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ae-test-'));
  try {
    await fs.writeFile(path.join(dir, 'My Loop.wav'), '');
    const result = await uniqueNamedPath(dir, 'My Loop');
    assert.equal(result, path.join(dir, 'My Loop_2.wav'));
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});


test('sanitizeOutputName keeps names that are fine on macOS and Windows', () => {
  assert.equal(sanitizeOutputName('Kick 01 (tight)'), 'Kick 01 (tight)');
});

test('sanitizeOutputName replaces characters macOS or Windows forbid', () => {
  assert.equal(sanitizeOutputName('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
});

test('sanitizeOutputName drops trailing dots and spaces Windows would strip', () => {
  assert.equal(sanitizeOutputName('loop. . '), 'loop');
});

test('sanitizeOutputName suffixes Windows reserved device names', () => {
  for (const n of ['CON', 'nul', 'Com1', 'LPT9']) assert.equal(sanitizeOutputName(n), `${n}_`);
  assert.equal(sanitizeOutputName('console'), 'console');
});

test('sanitizeOutputName caps very long names', () => {
  assert.equal(sanitizeOutputName('x'.repeat(300)).length, 120);
});
