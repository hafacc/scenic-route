import { expect, test } from "bun:test";
import {
  decodeNetwork,
  encodeNetwork,
  NETWORK_HEADER_BYTES,
  NETWORK_RECORD_BYTES,
  UNNAMED_ID,
} from "../../scripts/geometry";

// Pinned against scripts/README.md, not the encoder: a round trip can't see a mirrored mistake.

const COORD_SCALE = 1e-6;

interface Fixture {
  id: number;
  nameId: number;
  lengthMeters: number;
  kind: number;
  width: number;
  speed: number;
  flags: number;
  points: [lng: number, lat: number][];
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

// Header, 24-byte records, the varint-delta coordinates, two density bytes a vertex, then names.
function writeNetwork(
  magic: string,
  format: number,
  records: readonly Fixture[],
  names: readonly string[],
  densities: readonly number[],
): Uint8Array {
  const originLng = Math.min(
    ...records.flatMap((record) => record.points.map(([lng]) => lng)),
  );
  const originLat = Math.min(
    ...records.flatMap((record) => record.points.map(([, lat]) => lat)),
  );

  const coordinates: number[] = [];
  const starts: number[] = [];
  for (const record of records) {
    starts.push(coordinates.length);
    let previousX = 0;
    let previousY = 0;
    for (const [lng, lat] of record.points) {
      const x = Math.round((lng - originLng) / COORD_SCALE);
      const y = Math.round((lat - originLat) / COORD_SCALE);
      writeVarint(coordinates, zigzag(x - previousX));
      writeVarint(coordinates, zigzag(y - previousY));
      previousX = x;
      previousY = y;
    }
  }

  const nameBlob: number[] = [];
  const encoder = new TextEncoder();
  nameBlob.push(names.length & 0xff, 0, 0, 0);
  for (const name of names) {
    const bytes = encoder.encode(name);
    nameBlob.push(bytes.length & 0xff, bytes.length >> 8, ...bytes);
  }

  const coordOffset =
    NETWORK_HEADER_BYTES + records.length * NETWORK_RECORD_BYTES;
  const densityOffset = coordOffset + coordinates.length;
  const nameOffset = densityOffset + densities.length;
  const file = new Uint8Array(nameOffset + nameBlob.length);
  const view = new DataView(file.buffer);

  for (let index = 0; index < 4; index++) {
    file[index] = magic.charCodeAt(index);
  }
  view.setUint16(4, format, true);
  view.setUint16(6, NETWORK_HEADER_BYTES, true);
  view.setUint16(8, NETWORK_RECORD_BYTES, true);
  view.setUint32(12, records.length, true);
  view.setFloat64(16, originLng, true);
  view.setFloat64(24, originLat, true);
  view.setFloat64(32, COORD_SCALE, true);
  view.setUint32(40, coordOffset, true);
  view.setUint32(44, coordinates.length, true);
  view.setUint32(48, densityOffset, true);
  view.setUint32(52, densities.length, true);
  view.setUint32(56, nameOffset, true);
  view.setUint32(60, nameBlob.length, true);

  let vertex = 0;
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    const at = NETWORK_HEADER_BYTES + index * NETWORK_RECORD_BYTES;
    view.setUint32(at, record.id, true);
    view.setUint32(at + 4, starts[index], true);
    view.setUint16(at + 8, record.points.length, true);
    view.setUint16(at + 10, record.nameId, true);
    view.setFloat32(at + 12, record.lengthMeters, true);
    view.setUint32(at + 16, vertex, true);
    file[at + 20] = record.kind;
    file[at + 21] = record.width;
    file[at + 22] = record.speed;
    file[at + 23] = record.flags;
    vertex += record.points.length;
  }
  file.set(coordinates, coordOffset);
  file.set(densities, densityOffset);
  file.set(nameBlob, nameOffset);
  return file;
}

const SIDEWALK_RECORDS: Fixture[] = [
  {
    id: 1_234_567,
    nameId: 0,
    lengthMeters: 41.5,
    kind: 20, // sidewalk
    width: 0,
    speed: 0,
    flags: 1 << 2, // structure
    points: [
      [-74.01, 40.7],
      [-74.0098, 40.7001],
      [-74.0096, 40.70025],
    ],
  },
  {
    id: 42,
    nameId: UNNAMED_ID,
    lengthMeters: 7.25,
    kind: 21, // crossing
    width: 0,
    speed: 0,
    flags: 0,
    points: [
      [-74.0099, 40.70005],
      [-74.0097, 40.7002],
    ],
  },
];
const SIDEWALK_NAMES = ["HUDSON RIVER GREENWAY"];

test("the network decoder reads a hand-written SWLK file", () => {
  // Non-zero, so a decoder at the wrong offset can't pass on the encoder's leftover zeros.
  const densities = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const decoded = decodeNetwork(
    writeNetwork("SWLK", 1, SIDEWALK_RECORDS, SIDEWALK_NAMES, densities),
  );

  expect(decoded.magic).toBe("SWLK");
  expect(decoded.format).toBe(1);
  expect(decoded.names).toEqual(SIDEWALK_NAMES);
  expect([...decoded.densities]).toEqual(densities);
  expect(decoded.records.map((record) => record.id)).toEqual([1_234_567, 42]);
  expect(decoded.records.map((record) => record.kind)).toEqual([20, 21]);
  expect(decoded.records.map((record) => record.nameId)).toEqual([0, 0xffff]);
  expect(decoded.records.map((record) => record.lengthMeters)).toEqual([
    41.5, 7.25,
  ]);
  expect(decoded.records.map((record) => record.flags)).toEqual([4, 0]);

  // The delta chain restarts per record, found through each record's own blob offset.
  const [first, second] = decoded.records;
  expect(first.points).toHaveLength(3);
  expect(second.points).toHaveLength(2);
  for (const [record, expected] of [
    [first, SIDEWALK_RECORDS[0].points],
    [second, SIDEWALK_RECORDS[1].points],
  ] as const) {
    record.points.forEach(({ lng, lat }, index) => {
      expect(lng).toBeCloseTo(expected[index][0], 7);
      expect(lat).toBeCloseTo(expected[index][1], 7);
    });
  }
});

test("the network encoder writes those same bytes", () => {
  const zeroed = new Array(10).fill(0);
  const expected = writeNetwork(
    "SWLK",
    1,
    SIDEWALK_RECORDS,
    SIDEWALK_NAMES,
    zeroed,
  );
  const encoded = encodeNetwork(
    "SWLK",
    1,
    SIDEWALK_RECORDS.map((record) => ({
      ...record,
      points: record.points.map(([lng, lat]) => ({ lng, lat })),
    })),
    SIDEWALK_NAMES,
  );
  expect([...encoded]).toEqual([...expected]);
});

// STRT v6 put the four sidewalk bits above the old three in the same flags byte.
test("STRT v6 carries the per-side sidewalk bits in the flags byte", () => {
  // Bit 7 is unclaimed, so a reader masking the byte down to known flags drops it.
  const flags = 0b1011_0101;
  const street: Fixture = {
    id: 7,
    nameId: 0,
    lengthMeters: 12.5,
    kind: 1, // rw_type street
    width: 34,
    speed: 25,
    flags,
    points: [
      [-73.99, 40.75],
      [-73.9898, 40.7501],
    ],
  };
  const decoded = decodeNetwork(
    writeNetwork("STRT", 6, [street], ["W 60 ST"], [0, 0, 0, 0]),
  );
  const record = decoded.records[0];
  expect(decoded.format).toBe(6);
  expect(record.flags).toBe(flags);
  expect(record.width).toBe(34);
  expect(record.speed).toBe(25);
  expect(decoded.names[record.nameId]).toBe("W 60 ST");
});
