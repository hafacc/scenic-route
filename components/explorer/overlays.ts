// Which overlays Explorer draws, apart from which ones the reader has switched on.
import type { City } from "../../src/cities";
import { OVERLAYS, type OverlayId } from "../../src/overlays/registry";

function isExclusive(id: OverlayId): boolean {
  return OVERLAYS.find((overlay) => overlay.id === id)?.exclusive ?? false;
}

// Tree genus is exclusive both ways, so its dense recoloring never fights the other overlays.
export function toggleOverlay(
  current: ReadonlySet<OverlayId>,
  id: OverlayId,
): Set<OverlayId> {
  const next = new Set(current);
  if (next.has(id)) {
    next.delete(id);
  } else if (isExclusive(id)) {
    next.clear();
    next.add(id);
  } else {
    next.add(id);
    for (const other of next) {
      if (isExclusive(other)) {
        next.delete(other);
      }
    }
  }
  return next;
}

// A layer the city lacks or the reader has hidden has no row, so it is never drawn; the choice is kept.
export function shownOverlays(
  chosen: ReadonlySet<OverlayId>,
  city: City,
  hidden: readonly OverlayId[],
): ReadonlySet<OverlayId> {
  return new Set(
    [...chosen].filter(
      (id) => city.overlays.includes(id) && !hidden.includes(id),
    ),
  );
}
