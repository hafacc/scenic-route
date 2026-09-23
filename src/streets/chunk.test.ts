import { expect, test } from "bun:test";
import { decodeStreetChunk } from "./chunk";

// Built from scripts/README.md, not the tiler: an encoder and decoder can share a mistake.

const COORD_SCALE = 1e-6;
const HEADER_BYTES = 40;
const FORMAT = 4;

interface Fixture {
  offsetDecimeters: number;
  points: [lng: number, lat: number][];
  densities: number[]; // two per vertex, left sidewalk then right
  stranded: boolean;
}

function writeVarint(bytes: number[], value: number): void {
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
}

function zigzag(value: number): number {
  return value < 0 ? -2 * value - 1 : 2 * value;
}

// Header, then each segment's header, deltas and densities, then the stranded bitmap, LSB first.
function writeChunk(
  originLng: number,
  originLat: number,
  segments: readonly Fixture[],
): Uint8Array {
  const body: number[] = [];
  for (const segment of segments) {
    body.push(segment.points.length & 0xff, segment.points.length >> 8);
    body.push(segment.offsetDecimeters);
    let previousX = 0;
    let previousY = 0;
    for (const [lng, lat] of segment.points) {
      const x = Math.round((lng - originLng) / COORD_SCALE);
      const y = Math.round((lat - originLat) / COORD_SCALE);
      writeVarint(body, zigzag(x - previousX));
      writeVarint(body, zigzag(y - previousY));
      previousX = x;
      previousY = y;
    }
    body.push(...segment.densities);
  }

  const bitmap = new Array(Math.ceil(segments.length / 8)).fill(0);
  segments.forEach((segment, index) => {
    if (segment.stranded) {
      bitmap[index >> 3] |= 1 << (index & 7);
    }
  });

  const file = new Uint8Array(HEADER_BYTES + body.length + bitmap.length);
  const view = new DataView(file.buffer);
  for (let index = 0; index < 4; index++) {
    file[index] = "STCK".charCodeAt(index);
  }
  view.setUint16(4, FORMAT, true);
  view.setUint16(6, HEADER_BYTES, true);
  view.setUint32(8, segments.length, true);
  view.setUint32(12, HEADER_BYTES + body.length, true);
  view.setFloat64(16, originLng, true);
  view.setFloat64(24, originLat, true);
  view.setFloat64(32, COORD_SCALE, true);
  file.set(body, HEADER_BYTES);
  file.set(bitmap, HEADER_BYTES + body.length);
  return file;
}

const ORIGIN_LNG = -74.01;
const ORIGIN_LAT = 40.7;

const SEGMENTS: Fixture[] = [
  {
    offsetDecimeters: 34,
    points: [
      [-74.009, 40.7005],
      [-74.0086, 40.7007],
    ],
    densities: [10, 20, 30, 40],
    stranded: false,
  },
  {
    offsetDecimeters: 0,
    points: [
      [-74.0075, 40.7011],
      [-74.007, 40.7014],
      [-74.0068, 40.7018],
    ],
    densities: [200, 200, 210, 210, 220, 220],
    stranded: true,
  },
  {
    offsetDecimeters: 0,
    points: [
      [-74.006, 40.702],
      [-74.0055, 40.7022],
    ],
    densities: [150, 150, 160, 160],
    stranded: false,
  },
];

test("the chunk decoder reads a hand-written STCK file", () => {
  const decoded = decodeStreetChunk(
    writeChunk(ORIGIN_LNG, ORIGIN_LAT, SEGMENTS).buffer as ArrayBuffer,
  );

  expect(decoded).toHaveLength(3);
  // Decimeters on the wire, meters out.
  decoded.forEach((segment, index) => {
    expect(segment.offsetMeters).toBeCloseTo(
      SEGMENTS[index].offsetDecimeters / 10,
      9,
    );
  });
  expect(decoded.map((segment) => [...segment.densities])).toEqual(
    SEGMENTS.map((segment) => segment.densities),
  );
  decoded.forEach((segment, index) => {
    const expected = SEGMENTS[index].points;
    expect(segment.lngs).toHaveLength(expected.length);
    expected.forEach(([lng, lat], vertex) => {
      expect(segment.lngs[vertex]).toBeCloseTo(lng, 7);
      expect(segment.lats[vertex]).toBeCloseTo(lat, 7);
    });
  });
});

test("a segment's stranded bit follows the segment, not its neighbors", () => {
  const decoded = decodeStreetChunk(
    writeChunk(ORIGIN_LNG, ORIGIN_LAT, SEGMENTS).buffer as ArrayBuffer,
  );
  expect(decoded.map((segment) => segment.stranded)).toEqual([
    false,
    true,
    false,
  ]);
});

// Nine segments so the bitmap spills into a second byte, with only the ninth set.
test("the stranded bitmap carries past its first byte", () => {
  const many: Fixture[] = Array.from({ length: 9 }, (_, index) => ({
    offsetDecimeters: 0,
    points: [
      [-74.006 + index * 1e-4, 40.702],
      [-74.0055 + index * 1e-4, 40.7022],
    ],
    densities: [1, 1, 2, 2],
    stranded: index === 8,
  }));
  const decoded = decodeStreetChunk(
    writeChunk(ORIGIN_LNG, ORIGIN_LAT, many).buffer as ArrayBuffer,
  );
  expect(decoded.map((segment) => segment.stranded)).toEqual(
    many.map((segment) => segment.stranded),
  );
});

test("a chunk whose bitmap was truncated is rejected", () => {
  const full = writeChunk(ORIGIN_LNG, ORIGIN_LAT, SEGMENTS);
  const short = full.slice(0, full.length - 1);
  expect(() => decodeStreetChunk(short.buffer as ArrayBuffer)).toThrow(
    "street chunk truncated",
  );
});
