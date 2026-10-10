import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { removeTempFile } from '../src/tempFiles.ts';
import { nextOutputPath } from '../src/projectPaths.ts';

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cliptool-tmp-'));
  try { await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

const exists = (p: string) => fs.access(p).then(() => true, () => false);

test('a temp file is deleted once Live has its own copy', () => withDir(async (dir) => {
  const out = path.join(dir, 'kick_edited_001.wav');
  await fs.writeFile(out, 'x');
  assert.equal(await removeTempFile(out, path.join(dir, 'Project', 'Samples', 'Imported', 'kick_edited_001.wav')), true);
  assert.equal(await exists(out), false);
}));

test('a file Live is using in place is kept', () => withDir(async (dir) => {
  const out = path.join(dir, 'kick_edited_001.wav');
  await fs.writeFile(out, 'x');
  assert.equal(await removeTempFile(out, path.join(dir, '.', 'kick_edited_001.wav')), false);
  assert.equal(await exists(out), true);
}));

test('the empty placeholder is deleted when processing fails before import', () => withDir(async (dir) => {
  const placeholder = await nextOutputPath(dir, 'kick');
  assert.equal((await fs.stat(placeholder)).size, 0);
  // Mirrors extension.ts: try { process (throws); import } finally { removeTempFile(output, imported) }
  let imported: string | undefined;
  await assert.rejects(async () => {
    try {
      throw new Error('processing failed');
    } finally {
      await removeTempFile(placeholder, imported);
    }
  }, /processing failed/);
  assert.equal(await exists(placeholder), false);
}));

test('a missing or empty path is ignored without throwing', async () => {
  assert.equal(await removeTempFile(path.join(os.tmpdir(), 'cliptool-does-not-exist.wav')), false);
  assert.equal(await removeTempFile(null), false);
  assert.equal(await removeTempFile(undefined), false);
});
