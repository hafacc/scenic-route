// An index from a link or a previous plan may be out of range, which would select nothing.
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

// `start` is null while the shell routes from the reader's location.
export interface EndpointsKey {
  start: string | null;
  dest: string;
}

// A start appearing isn't a move: the shell pins the first live fix once a destination exists.
export function endpointsMoved(
  previous: EndpointsKey | null,
  next: EndpointsKey | null,
): boolean {
  if (previous === null) {
    return false;
  } else if (next === null) {
    // A cleared destination makes whatever is typed next a new walk.
    return true;
  } else {
    return (
      next.dest !== previous.dest ||
      (previous.start !== null && previous.start !== next.start)
    );
  }
}
