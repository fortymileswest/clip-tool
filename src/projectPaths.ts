import * as path from 'node:path';
import * as fs from 'node:fs/promises';

export function getProcessedDir(songFilePath: string): string {
  return path.join(path.dirname(songFilePath), 'Samples', 'Processed');
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function nextOutputPath(dir: string, stem: string): Promise<string> {
  for (let n = 1; n <= 999; n++) {
    const candidate = path.join(dir, `${stem}_edited_${String(n).padStart(3, '0')}.wav`);
    try {
      const fh = await fs.open(candidate, 'wx');
      await fh.close();
      return candidate;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`Could not find a free output path for stem "${stem}" after 999 attempts`);
}

// For an explicitly renamed sample: use the exact name, appending _2, _3, …
// only to avoid clobbering an existing file. Atomic wx create guards races.
export async function uniqueNamedPath(dir: string, name: string): Promise<string> {
  for (let n = 1; n <= 999; n++) {
    const candidate = path.join(dir, n === 1 ? `${name}.wav` : `${name}_${n}.wav`);
    try {
      const fh = await fs.open(candidate, 'wx');
      await fh.close();
      return candidate;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`Could not find a free output path for name "${name}" after 999 attempts`);
}
