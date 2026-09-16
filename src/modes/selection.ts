// Which card the reader is on, held against the plan that is actually on screen.

// A card index arrives from a link or is left over from the plan before this one, and neither is a
// promise that the plan has a card there. Out of range it selected nothing at all: the card header
// and the whole list went away while the map still drew a route, and the index went back into the
// share link as a number no one could open.
export function clampSelection(
  selected: number | null,
  cardCount: number,
): number | null {
  if (
    selected === null ||
    !Number.isInteger(selected) ||
    selected < 0 ||
    selected >= cardCount
  ) {
    return null;
  } else {
    return selected;
  }
}

// The walk a plan was made for: the two endpoints as text, the start absent while the reader has
// named none and the shell is routing from wherever they are.
export interface EndpointsKey {
  start: string | null;
  dest: string;
}

// Whether the reader moved the walk, which is what retires the card they had chosen.
//
// A start appearing where there was none is NOT a move: the shell pins the first live fix as the
// start the moment a destination exists, so a link carrying `to` and a card but no `from` lost its
// card the instant the reader's location landed.
export function endpointsMoved(
  previous: EndpointsKey | null,
  next: EndpointsKey | null,
): boolean {
  if (previous === null) {
    return false;
  } else if (next === null) {
    // The destination was cleared. Whatever is typed next is another walk, and holding the card
    // through the gap hands it to that one.
    return true;
  } else {
    return (
      next.dest !== previous.dest ||
      (previous.start !== null && previous.start !== next.start)
    );
  }
}
