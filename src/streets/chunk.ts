// One STCK chunk per z12 tile (layout: scripts/README.md), bounds-checked so bad bytes throw.
const CHUNK_FORMAT = 4;
const SIDES = 2; // density bytes per vertex: left sidewalk then right, interleaved
const METERS_PER_DECIMETER = 0.1;

export interface StreetSegment {
  lngs: Float64Array;
  lats: Float64Array;
  // 0..255 for a covered fraction of 0..1; a segment with no offset repeats the value.
  densities: Uint8Array;
  // Meters; zero for a path or boardwalk, which is itself the walking surface.
  offsetMeters: number;
  // In a component the routing graph dropped, so drawing it would offer an unroutable walk.
  stranded: boolean;
}

// Guarded because reading past the end yields `undefined`, which coerces to 0 and decodes garbage.
function readVarint(bytes: Uint8Array, cursor: { offset: number }): number {
  let value = 0;
  let shift = 0;
  let byte = 0;
  do {
    if (cursor.offset >= bytes.length) {
      throw new Error("street chunk truncated");
    }
    byte = bytes[cursor.offset];
    cursor.offset += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return (value >>> 1) ^ -(value & 1);
}

export function decodeStreetChunk(buffer: ArrayBuffer): StreetSegment[] {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const version = view.getUint16(4, true);
  if (magic !== "STCK" || version !== CHUNK_FORMAT) {
    throw new Error(`not a v${CHUNK_FORMAT} street chunk`);
  }

  const count = view.getUint32(8, true);
  const strandedOffset = view.getUint32(12, true);
  if (strandedOffset + Math.ceil(count / 8) > bytes.length) {
    throw new Error("street chunk truncated");
  }
  const originLng = view.getFloat64(16, true);
  const originLat = view.getFloat64(24, true);
  const scale = view.getFloat64(32, true);
  const cursor = { offset: view.getUint16(6, true) };

  const segments: StreetSegment[] = [];
  for (let segment = 0; segment < count; segment++) {
    if (cursor.offset + 3 > bytes.length) {
      throw new Error("street chunk truncated");
    }
    const vertices = view.getUint16(cursor.offset, true);
    const offsetMeters = bytes[cursor.offset + 2] * METERS_PER_DECIMETER;
    cursor.offset += 3;
    const lngs = new Float64Array(vertices);
    const lats = new Float64Array(vertices);
    let quantizedX = 0;
    let quantizedY = 0;
    for (let vertex = 0; vertex < vertices; vertex++) {
      quantizedX += readVarint(bytes, cursor);
      quantizedY += readVarint(bytes, cursor);
      lngs[vertex] = originLng + quantizedX * scale;
      lats[vertex] = originLat + quantizedY * scale;
    }
    if (cursor.offset + SIDES * vertices > bytes.length) {
      throw new Error("street chunk truncated");
    }
    const densities = bytes.slice(
      cursor.offset,
      cursor.offset + SIDES * vertices,
    );
    cursor.offset += SIDES * vertices;
    const stranded =
      (bytes[strandedOffset + (segment >> 3)] & (1 << (segment & 7))) !== 0;
    segments.push({ lngs, lats, densities, offsetMeters, stranded });
  }
  return segments;
}
