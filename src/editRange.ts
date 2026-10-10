// Which part of the original render the backend should process, shared by the
// editor's Process, Copy to Arrangement and Simpler buttons so all three render
// exactly what the preview plays. Compiled to a browser global (EditRange) for
// the webview, and imported directly by the tests.

export interface RangeState {
  /** A fade-in or fade-out is set. Fades are anchored to the selection edges. */
  hasFades: boolean;
  /** The loop/selection is shown and enabled. */
  hasExplicitSelection: boolean;
  /** Seconds the working view starts into the original render (Trim to Selection). */
  viewOffset: number;
  /** Length of the working view in seconds. */
  currentDuration: number;
  /** Length of the original render in seconds. */
  originalDuration: number;
  /** Selection start, editor-local seconds. */
  trimStart: number;
  /** Selection end, editor-local seconds. */
  trimEnd: number;
}

export interface RenderRange {
  crop: boolean;
  /** Seconds into the original render. */
  trimStart: number;
  trimEnd: number;
}

const TRIM_EPS = 1e-6;

/** True once Trim to Selection has narrowed the working view. */
export function hasTrimmedView(s: Pick<RangeState, 'viewOffset' | 'currentDuration' | 'originalDuration'>): boolean {
  return s.viewOffset > TRIM_EPS || s.currentDuration < s.originalDuration - TRIM_EPS;
}

/**
 * The backend always renders from the original file, so the editor must crop
 * back to the selection whenever what the user hears is narrower than the
 * whole file: an enabled selection, a trimmed view, or fades (which sit on the
 * selection edges, so without a crop they would land on the file edges).
 */
export function renderRange(s: RangeState): RenderRange {
  return {
    crop: s.hasFades || s.hasExplicitSelection || hasTrimmedView(s),
    trimStart: s.viewOffset + s.trimStart,
    trimEnd: s.viewOffset + s.trimEnd,
  };
}

/** Stretch limits. Beyond these WSOLA output is mostly smeared repeats or
 *  dropped material, and a typo in the target BPM (e.g. 12 for 120) could ask
 *  for a result many minutes long. */
export const MIN_STRETCH = 0.25;
export const MAX_STRETCH = 4;

export interface ClampedStretch {
  ratio: number;
  /** 'min' or 'max' when the requested ratio was outside the limits. */
  limit: 'min' | 'max' | null;
}

/** Clamps a stretch ratio (output length / input length) to MIN..MAX_STRETCH.
 *  Non-finite or non-positive ratios mean "no stretch". */
export function clampStretchRatio(ratio: number): ClampedStretch {
  if (!Number.isFinite(ratio) || ratio <= 0) return { ratio: 1, limit: null };
  if (ratio < MIN_STRETCH) return { ratio: MIN_STRETCH, limit: 'min' };
  if (ratio > MAX_STRETCH) return { ratio: MAX_STRETCH, limit: 'max' };
  return { ratio, limit: null };
}
