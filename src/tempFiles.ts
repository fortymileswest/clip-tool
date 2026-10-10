import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Canonical form of a path for comparison: symlinks resolved where the file
// exists, and case-folded on Windows, whose file system ignores case.
async function canonical(p: string): Promise<string> {
  let r: string;
  try {
    r = await fs.realpath(p);
  } catch {
    r = path.resolve(p);
  }
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/**
 * Deletes a temp file Clip Tool wrote (the render from Live, the processed
 * output, or the empty placeholder reserved for it). Never throws: a missing
 * file or a failed delete must not turn a finished edit into an error.
 *
 * `inUse` is a path Live is now using. importIntoProject copies the file into
 * the project and returns the copy's path, so the temp file is normally safe to
 * delete; if Live ever hands back the same file, under any spelling, it is kept.
 */
export async function removeTempFile(file: string | null | undefined, inUse?: string | null): Promise<boolean> {
  if (!file) return false;
  if (inUse && (await canonical(inUse)) === (await canonical(file))) return false;
  try {
    await fs.unlink(file);
    return true;
  } catch {
    return false;
  }
}
