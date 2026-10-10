// How long the new arrangement clip should be, in beats. Kept free of SDK
// imports so it can be tested directly.
//
// The rendered file always holds the whole result. When it fits before the
// next clip on the track, the clip shows all of it. When a longer result (a
// stretch) would run into a neighbour, the clip keeps the original clip's
// size instead, and the rest stays in the file as a tail that can be dragged
// out later. A neighbour is never overlapped.

export interface Span {
  start: number;
  end: number;
}

export interface PlacementInput {
  /** Where the new clip starts, in beats. */
  start: number;
  /** The rendered file's length at the song tempo, in beats. */
  naturalLength: number;
  /** The size to keep when the result does not fit: the original clip's. */
  keepLength: number;
  /** The other clips on the track (excluding any the edit replaces). */
  others: Span[];
}

const EPS = 1e-6;

/**
 * Clip duration in beats, or undefined for the file's natural length (the
 * whole result, which is what createAudioClip does with no duration).
 */
export function clipDuration(p: PlacementInput): number | undefined {
  // The nearest clip that starts at or after ours.
  let next = Infinity;
  for (const o of p.others) {
    if (o.start >= p.start - EPS && o.start < next) next = o.start;
  }
  const room = next - p.start;
  if (p.naturalLength <= room + EPS) return undefined;
  // Doesn't fit: keep the original size, but never past the neighbour.
  return Math.max(EPS, Math.min(p.keepLength, room));
}
