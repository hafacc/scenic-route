// L.CRS.EPSG3857 transcribed exactly: leaflet reads `document` at import, so can't load in a worker.

const EARTH_RADIUS = 6_378_137;
const MAX_LATITUDE = 85.051_128_779_8;
const TRANSFORM_SCALE = 0.5 / (Math.PI * EARTH_RADIUS);
const RADIANS_PER_DEGREE = Math.PI / 180;
const DEGREES_PER_RADIAN = 180 / Math.PI;

export interface LatLng {
  lat: number;
  lng: number;
}

export function projectX(lng: number, zoom: number): number {
  const mercatorX = EARTH_RADIUS * lng * RADIANS_PER_DEGREE;
  return 256 * 2 ** zoom * (TRANSFORM_SCALE * mercatorX + 0.5);
}

export function projectY(lat: number, zoom: number): number {
  const clamped = Math.max(Math.min(MAX_LATITUDE, lat), -MAX_LATITUDE);
  const sin = Math.sin(clamped * RADIANS_PER_DEGREE);
  const mercatorY = (EARTH_RADIUS * Math.log((1 + sin) / (1 - sin))) / 2;
  return 256 * 2 ** zoom * (-TRANSFORM_SCALE * mercatorY + 0.5);
}

export function unproject(x: number, y: number, zoom: number): LatLng {
  const scale = 256 * 2 ** zoom;
  const mercatorX = (x / scale - 0.5) / TRANSFORM_SCALE;
  const mercatorY = (y / scale - 0.5) / -TRANSFORM_SCALE;
  return {
    lat:
      (2 * Math.atan(Math.exp(mercatorY / EARTH_RADIUS)) - Math.PI / 2) *
      DEGREES_PER_RADIAN,
    lng: (mercatorX * DEGREES_PER_RADIAN) / EARTH_RADIUS,
  };
}
