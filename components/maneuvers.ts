// What the maneuver list shares that is not a component.
import {
  MdAccountBalance,
  MdArrowUpward,
  MdDirectionsBoat,
  MdElevator,
  MdFlag,
  MdLogout,
  MdOutlineDirectionsWalk,
  MdPalette,
  MdStairs,
  MdSwapHoriz,
  MdTransferWithinAStation,
  MdTurnLeft,
  MdTurnRight,
  MdTurnSlightLeft,
  MdTurnSlightRight,
  MdUTurnLeft,
} from "../src/icons/glyphs";
import type { IconData } from "../src/icons/types";
import type { Maneuver } from "../src/routing/directions";
import type { NavProgress } from "../src/routing/nav-progress";

// Drawn with `class="h-4 w-4"` and `aria-hidden`, which the element this returned used to carry.
export function maneuverIcon(maneuver: Maneuver): IconData {
  if (maneuver.kind === "landmark") {
    return MdAccountBalance;
  }
  if (maneuver.kind === "art") {
    return MdPalette;
  }
  if (maneuver.kind === "cross") {
    return MdSwapHoriz;
  }
  if (maneuver.kind === "arrive") {
    return MdFlag;
  }
  if (maneuver.kind === "ferry") {
    return MdDirectionsBoat;
  }
  if (maneuver.kind === "station") {
    if (maneuver.station === "alight") {
      return MdLogout;
    }
    if (maneuver.station === "change") {
      return MdTransferWithinAStation;
    }
    if (maneuver.door === "elevator") {
      return MdElevator;
    }
    return MdStairs;
  }
  if (maneuver.kind === "continue") {
    return MdArrowUpward;
  }
  if (maneuver.kind === "turn") {
    switch (maneuver.turn) {
      case "left":
        return MdTurnLeft;
      case "right":
        return MdTurnRight;
      case "slight left":
        return MdTurnSlightLeft;
      case "slight right":
        return MdTurnSlightRight;
      case "around":
        return MdUTurnLeft;
      default:
        return MdOutlineDirectionsWalk;
    }
  }
  return MdOutlineDirectionsWalk;
}

// nextManeuver, not currentManeuver, so the arrive row is never dimmed and highlighted at once.
export function maneuverState(
  progress: NavProgress | null,
  index: number,
): "passed" | "next" | "ahead" {
  if (progress === null) {
    return "ahead";
  } else if (index === progress.nextManeuver) {
    return "next";
  } else if (index < progress.nextManeuver) {
    return "passed";
  } else {
    return "ahead";
  }
}

export interface PeekNext {
  maneuver: Maneuver;
  distanceMeters: number;
  // Only a ride changes the bar: there is no walking left and no fix underground.
  current: Maneuver | null;
}
