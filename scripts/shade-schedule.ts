// Shade bins on a (declination, hourAngle) grid; each bin's sun position is computed from its cell.

import {
  DECL_MAX_DEG,
  DISK_SAMPLES,
  HOUR_ANGLE_STEP_DEG,
  SEASON_BANDS,
  type SunSample,
  sunSamples,
} from "../src/shade/sun";
import manifest from "../src/tree-cover/manifest.json";

const DEGREES = Math.PI / 180;
const HORIZON_DEG = 0.5; // at or below, the sun is down

// The client sweeps casters itself below this level, so the pyramid stops here.
export const SHADE_MAX_ZOOM = 14;
export const SHADE_MAX_SHADOW_METERS = 500;

interface ShadeBucket {
  season: number; // declination band in [0, SEASON_BANDS)
  hourAngle: number; // degrees, 0 at solar noon
  elevation: number; // degrees
  azimuth: number; // degrees clockwise from north
  intensity: number; // ~sin(elevation)
  samples: SunSample[];
}

// The forward solution that src/shade/sun.ts inverts.
function positionOf(
  declDeg: number,
  hourAngleDeg: number,
  latDeg: number,
): { elevation: number; azimuth: number } {
  const decl = declDeg * DEGREES;
  const hour = hourAngleDeg * DEGREES;
  const lat = latDeg * DEGREES;
  const sinEl =
    Math.sin(lat) * Math.sin(decl) +
    Math.cos(lat) * Math.cos(decl) * Math.cos(hour);
  const elevation = Math.asin(Math.min(1, Math.max(-1, sinEl)));
  const sinAz = (-Math.cos(decl) * Math.sin(hour)) / Math.cos(elevation);
  const cosAz =
    (Math.sin(decl) - Math.sin(lat) * Math.sin(elevation)) /
    (Math.cos(lat) * Math.cos(elevation));
  const azimuth = Math.atan2(sinAz, cosAz) / DEGREES;
  return {
    elevation: elevation / DEGREES,
    azimuth: (azimuth + 360) % 360,
  };
}

// Per city: latitude changes which bins exist, so cities share neither bin indices nor pyramids.
export function computeShadeBuckets(cityId: string): ShadeBucket[] {
  const city = manifest.cities.find((entry) => entry.id === cityId);
  if (!city) {
    throw new Error(`no city ${cityId} in the manifest`);
  }
  const centerLat = (city.bounds.north + city.bounds.south) / 2;

  const buckets: ShadeBucket[] = [];
  const bandWidth = (2 * DECL_MAX_DEG) / SEASON_BANDS;
  for (let band = 0; band < SEASON_BANDS; band++) {
    const declination = -DECL_MAX_DEG + (band + 0.5) * bandWidth;
    // Sunset hour angle: cos H = -tan φ tan δ.
    const cosSunset =
      -Math.tan(centerLat * DEGREES) * Math.tan(declination * DEGREES);
    const maxHourAngle =
      Math.abs(cosSunset) >= 1
        ? cosSunset < 0
          ? 180 // sun never sets
          : 0
        : Math.acos(cosSunset) / DEGREES;
    const steps = Math.floor(maxHourAngle / HOUR_ANGLE_STEP_DEG);
    for (let step = -steps; step <= steps; step++) {
      const hourAngle = step * HOUR_ANGLE_STEP_DEG;
      const position = positionOf(declination, hourAngle, centerLat);
      if (position.elevation <= HORIZON_DEG) {
        continue;
      }
      buckets.push({
        season: band,
        hourAngle,
        elevation: position.elevation,
        azimuth: position.azimuth,
        intensity: Math.max(0, Math.sin(position.elevation * DEGREES)),
        samples: sunSamples(position.azimuth, position.elevation, DISK_SAMPLES),
      });
    }
  }
  // Stable order, so bin indices don't churn between builds.
  buckets.sort(
    (left, right) =>
      left.season - right.season || left.hourAngle - right.hourAngle,
  );
  return buckets;
}
