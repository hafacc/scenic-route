// Shadows depend only on declination and hour angle, so bins grid those; shared with the bake
// (scripts/shade-schedule.ts). Azimuth is suncalc's: clockwise from north.
const DEGREES = Math.PI / 180;

export const DECL_MAX_DEG = 23.44;

// 15° of hour angle is 1 h; the bin count trades against pyramid size at SHADE_MAX_ZOOM.
export const SEASON_BANDS = 6;
export const HOUR_ANGLE_STEP_DEG = 18;

// The sun is a disk ~0.53° across, so shadows are averaged over samples to get a penumbra.
const SUN_ANGULAR_RADIUS_DEG = 0.265;
export const DISK_SAMPLES = 6;

// The ground unit vector points down the shadow (anti-sun); length is per meter of caster height.
export interface SunSample {
  east: number;
  north: number;
  shadowPerHeight: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

// Index 0 is the center; azimuth offsets divide by cos(elevation) to stay a circle on the sky.
export function sunSamples(
  azimuthDeg: number,
  elevationDeg: number,
  count: number,
): SunSample[] {
  const ringRadius = SUN_ANGULAR_RADIUS_DEG * 0.75;
  const cosElevation = Math.cos(elevationDeg * DEGREES);
  const samples: SunSample[] = [];
  for (let index = 0; index < count; index++) {
    let deltaElevation = 0;
    let deltaAzimuth = 0;
    if (index > 0) {
      const angle = (2 * Math.PI * (index - 1)) / (count - 1);
      deltaElevation = ringRadius * Math.cos(angle);
      deltaAzimuth = (ringRadius * Math.sin(angle)) / cosElevation;
    }
    const azimuth = (azimuthDeg + deltaAzimuth) * DEGREES;
    const elevation = (elevationDeg + deltaElevation) * DEGREES;
    samples.push({
      east: -Math.sin(azimuth),
      north: -Math.cos(azimuth),
      shadowPerHeight: 1 / Math.tan(elevation),
    });
  }
  return samples;
}

// Inverts the altitude formula: sin δ = sin φ sin el + cos φ cos el cos A.
export function declinationOf(
  elevationDeg: number,
  azimuthDeg: number,
  latDeg: number,
): number {
  const elevation = elevationDeg * DEGREES;
  const azimuth = azimuthDeg * DEGREES;
  const lat = latDeg * DEGREES;
  const sinDecl =
    Math.sin(lat) * Math.sin(elevation) +
    Math.cos(lat) * Math.cos(elevation) * Math.cos(azimuth);
  return Math.asin(clamp(sinDecl, -1, 1)) / DEGREES;
}

// Degrees: 0 at solar noon, negative before it.
export function hourAngleOf(
  elevationDeg: number,
  azimuthDeg: number,
  latDeg: number,
  declDeg: number,
): number {
  const elevation = elevationDeg * DEGREES;
  const azimuth = azimuthDeg * DEGREES;
  const lat = latDeg * DEGREES;
  const decl = declDeg * DEGREES;
  const sinHour = (-Math.cos(elevation) * Math.sin(azimuth)) / Math.cos(decl);
  const cosHour =
    (Math.sin(elevation) - Math.sin(lat) * Math.sin(decl)) /
    (Math.cos(lat) * Math.cos(decl));
  return Math.atan2(sinHour, cosHour) / DEGREES;
}

// Dates six months apart at one declination cast identical shadows and share a band.
export function seasonBand(declDeg: number): number {
  const fraction = (declDeg + DECL_MAX_DEG) / (2 * DECL_MAX_DEG);
  return clamp(Math.floor(fraction * SEASON_BANDS), 0, SEASON_BANDS - 1);
}
