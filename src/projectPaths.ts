import * as path from 'node:path';
import * as fs from 'node:fs/promises';

// Device names Windows reserves in any folder, with or without an extension.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/**
 * Makes a user-typed sample name safe as a file stem on macOS and Windows:
 * characters either system forbids become '_', trailing dots and spaces (which
 * Windows drops) are removed, a reserved device name gets a '_' suffix, and the
 * stem is capped well below path limits. Returns '' when nothing usable is left.
 */
export function sanitizeOutputName(name: string): string {
  let s = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().replace(/[. ]+$/, '');
  if (s.length > 120) s = s.slice(0, 120).replace(/[. ]+$/, '');
  if (WINDOWS_RESERVED.test(s)) s += '_';
  return s;
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
