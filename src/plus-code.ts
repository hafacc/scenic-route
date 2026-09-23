// Open Location Code, 10 digits (~14 m), the length map apps expect as search input.
// Spec: https://github.com/google/open-location-code/blob/main/docs/specification.md

const ALPHABET = "23456789CFGHJMPQRVWX";
const SEPARATOR = "+";
const SEPARATOR_POSITION = 8;

// Integer 1/8000° units keep the base-20 decomposition exact.
const PAIR_COUNT = 5;
const UNITS_PER_DEGREE = 8000;
const PAIR_BASE = 20;
const LAT_UNITS_RANGE = 180 * UNITS_PER_DEGREE;
const LNG_UNITS_RANGE = 360 * UNITS_PER_DEGREE;

export function encodePlusCode(lat: number, lng: number): string {
  // The spec's upper bound is exclusive; the unit clamp keeps an exact 90 in range.
  const latitude = Math.max(-90, Math.min(90, lat));

  let longitude = lng;
  while (longitude >= 180) {
    longitude -= 360;
  }
  while (longitude < -180) {
    longitude += 360;
  }

  // Floor, not round: a code names the cell its coordinate falls on or past.
  let latUnits = Math.floor((latitude + 90) * UNITS_PER_DEGREE);
  let lngUnits = Math.floor((longitude + 180) * UNITS_PER_DEGREE);
  latUnits = Math.max(0, Math.min(LAT_UNITS_RANGE - 1, latUnits));
  lngUnits = Math.max(0, Math.min(LNG_UNITS_RANGE - 1, lngUnits));

  const pairs: string[] = [];
  for (let pairIndex = 0; pairIndex < PAIR_COUNT; pairIndex++) {
    pairs.push(ALPHABET[latUnits % PAIR_BASE] + ALPHABET[lngUnits % PAIR_BASE]);
    latUnits = Math.floor(latUnits / PAIR_BASE);
    lngUnits = Math.floor(lngUnits / PAIR_BASE);
  }
  const code = pairs.reverse().join("");
  return (
    code.slice(0, SEPARATOR_POSITION) +
    SEPARATOR +
    code.slice(SEPARATOR_POSITION)
  );
}
