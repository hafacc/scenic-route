// Fraction of direct sunlight a crown blocks by date; unbaked because a January crown blocks ~half.
// In leaf: i-Tree shade coefficients (Nowak 2024; McPherson et al. 2018) at our 22.9 cm median trunk.
// Leaf-off: Heisler 1986 (Urban Ecology 9:337-359) leafless/in-leaf ratio ~0.49 × 0.814.
const IN_LEAF = 0.814;
const LEAF_OFF = 0.4;

// Rain kept off the sidewalk: Zabret & Sraj's urban birch, at the low end of a 0.20-0.55 bracket;
// not the light tau, which would overvalue a tree 2x once a storm saturates the crown.
const RAIN_IN_LEAF = 0.35;
const RAIN_LEAF_OFF = 0.15;

type Transition = [start: [number, number], end: [number, number]];

// [month, day]: leaf-out late April, peak fall late Oct to mid Nov (NYC Parks, Central Park
// Conservancy); leaf-out drifts ~0.43 d/yr later (doi 10.1088/1748-9326/adf1b9).
const LEAF_OUT: Transition = [
  [4, 12],
  [5, 6],
];
const LEAF_FALL: Transition = [
  [10, 5],
  [12, 5],
];

// Smoothstep is an unmeasured choice; only the endpoints and dates are sourced.
function ramp(day: number, year: number, [start, end]: Transition): number {
  const from = Date.UTC(year, start[0] - 1, start[1]);
  const to = Date.UTC(year, end[0] - 1, end[1]);
  const fraction = Math.min(1, Math.max(0, (day - from) / (to - from)));
  return fraction * fraction * (3 - 2 * fraction);
}

// The ramps never overlap, so this is 0 in winter and 1 in summer.
function leafed(date: Date): number {
  const year = date.getFullYear();
  const day = Date.UTC(year, date.getMonth(), date.getDate());
  return ramp(day, year, LEAF_OUT) - ramp(day, year, LEAF_FALL);
}

export function canopyTau(date: Date): number {
  return LEAF_OFF + (IN_LEAF - LEAF_OFF) * leafed(date);
}

export function rainTau(date: Date): number {
  return RAIN_LEAF_OFF + (RAIN_IN_LEAF - RAIN_LEAF_OFF) * leafed(date);
}
