import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { getProcessedDir, ensureDir, nextOutputPath, uniqueNamedPath } from '../src/projectPaths.ts';

test('getProcessedDir returns Samples/Processed relative to project dir', () => {
  const songPath = '/Users/danny/Music/MyProject/MyProject.als';
  const result = getProcessedDir(songPath);
  assert.equal(result, '/Users/danny/Music/MyProject/Samples/Processed');
});

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

test('ensureDir creates nested directories that do not exist', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ae-test-'));
  const nested = path.join(base, 'a', 'b', 'c');
  try {
    await ensureDir(nested);
    const stat = await fs.stat(nested);
    assert.ok(stat.isDirectory(), 'nested path should be a directory');
  } finally {
    await fs.rm(base, { recursive: true });
  }
});
