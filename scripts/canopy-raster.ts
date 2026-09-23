// Bay Area counties publish a 1 m canopy raster rather than polygons, so this traces the polygons.

import type { Coord } from "./socrata";

// GRS80, the ellipsoid these rasters are referenced to.
const SEMI_MAJOR_METERS = 6_378_137.0;
const INVERSE_FLATTENING = 298.257222101;

// The same five numbers crates/tiler/src/heights.rs resolves a CRS to.
export interface Tmerc {
  centralMeridian: number;
  latOrigin: number;
  scaleFactor: number;
  falseEasting: number;
  falseNorthing: number;
}

/// NAD83(2011) / UTM zone 10N (EPSG:6339); the tiler calls it `utm10n`.
export const UTM_10N: Tmerc = {
  centralMeridian: -123.0,
  latOrigin: 0.0,
  scaleFactor: 0.9996,
  falseEasting: 500_000.0,
  falseNorthing: 0.0,
};

// Must match the tiler's forward projection exactly, since the inverse below undoes it.
function meridianArc(phi: number, eccentricity2: number): number {
  return (
    SEMI_MAJOR_METERS *
    ((1 -
      eccentricity2 / 4 -
      (3 * eccentricity2 ** 2) / 64 -
      (5 * eccentricity2 ** 3) / 256) *
      phi -
      ((3 * eccentricity2) / 8 +
        (3 * eccentricity2 ** 2) / 32 +
        (45 * eccentricity2 ** 3) / 1024) *
        Math.sin(2 * phi) +
      ((15 * eccentricity2 ** 2) / 256 + (45 * eccentricity2 ** 3) / 1024) *
        Math.sin(4 * phi) -
      ((35 * eccentricity2 ** 3) / 3072) * Math.sin(6 * phi))
  );
}

// Snyder's series; millimeter-accurate this close to the central meridian.
export function inverseTmerc(grid: Tmerc, x: number, y: number): Coord {
  const flattening = 1 / INVERSE_FLATTENING;
  const eccentricity2 = flattening * (2 - flattening);
  const second2 = eccentricity2 / (1 - eccentricity2);
  const root = Math.sqrt(1 - eccentricity2);
  const first = (1 - root) / (1 + root);

  const meridian =
    (y - grid.falseNorthing) / grid.scaleFactor +
    meridianArc((grid.latOrigin * Math.PI) / 180, eccentricity2);
  const mu =
    meridian /
    (SEMI_MAJOR_METERS *
      (1 -
        eccentricity2 / 4 -
        (3 * eccentricity2 ** 2) / 64 -
        (5 * eccentricity2 ** 3) / 256));
  // The footpoint latitude: where the meridional arc above would land on the central meridian.
  const foot =
    mu +
    ((3 * first) / 2 - (27 * first ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * first ** 2) / 16 - (55 * first ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * first ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * first ** 4) / 512) * Math.sin(8 * mu);

  const sinFoot = Math.sin(foot);
  const cosFoot = Math.cos(foot);
  const tanFoot = sinFoot / cosFoot;
  const tan2 = tanFoot * tanFoot;
  const cos2 = second2 * cosFoot * cosFoot;
  const curvature =
    SEMI_MAJOR_METERS / Math.sqrt(1 - eccentricity2 * sinFoot * sinFoot);
  const radius =
    (SEMI_MAJOR_METERS * (1 - eccentricity2)) /
    (1 - eccentricity2 * sinFoot * sinFoot) ** 1.5;
  const along = (x - grid.falseEasting) / (curvature * grid.scaleFactor);
  const along2 = along * along;

  const lat =
    foot -
    ((curvature * tanFoot) / radius) *
      (along2 / 2 -
        ((5 + 3 * tan2 + 10 * cos2 - 4 * cos2 * cos2 - 9 * second2) *
          along2 *
          along2) /
          24 +
        ((61 +
          90 * tan2 +
          298 * cos2 +
          45 * tan2 * tan2 -
          252 * second2 -
          3 * cos2 * cos2) *
          along2 ** 3) /
          720);
  const lng =
    (along -
      ((1 + 2 * tan2 + cos2) * along * along2) / 6 +
      ((5 -
        2 * cos2 +
        28 * tan2 -
        3 * cos2 * cos2 +
        8 * second2 +
        24 * tan2 * tan2) *
        along *
        along2 *
        along2) /
        120) /
    cosFoot;
  return {
    lat: (lat * 180) / Math.PI,
    lng: grid.centralMeridian + (lng * 180) / Math.PI,
  };
}

// The same series crates/tiler/src/heights.rs projects a canopy vertex with.
export function forwardTmerc(
  grid: Tmerc,
  lng: number,
  lat: number,
): { x: number; y: number } {
  const flattening = 1 / INVERSE_FLATTENING;
  const eccentricity2 = flattening * (2 - flattening);
  const second2 = eccentricity2 / (1 - eccentricity2);
  const phi = (lat * Math.PI) / 180;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const tanPhi = sinPhi / cosPhi;
  const curvature =
    SEMI_MAJOR_METERS / Math.sqrt(1 - eccentricity2 * sinPhi * sinPhi);
  const tan2 = tanPhi * tanPhi;
  const eta2 = second2 * cosPhi * cosPhi;
  const east = ((lng - grid.centralMeridian) * Math.PI * cosPhi) / 180;
  const east2 = east * east;
  const meridian =
    meridianArc(phi, eccentricity2) -
    meridianArc((grid.latOrigin * Math.PI) / 180, eccentricity2);
  return {
    x:
      grid.scaleFactor *
        curvature *
        (east +
          ((1 - tan2 + eta2) * east * east2) / 6 +
          ((5 - 18 * tan2 + tan2 * tan2 + 72 * eta2 - 58 * second2) *
            east *
            east2 *
            east2) /
            120) +
      grid.falseEasting,
    y:
      grid.scaleFactor *
        (meridian +
          curvature *
            tanPhi *
            (east2 / 2 +
              ((5 - tan2 + 9 * eta2 + 4 * eta2 * eta2) * east2 * east2) / 24 +
              ((61 - 58 * tan2 + tan2 * tan2 + 600 * eta2 - 330 * second2) *
                east2 ** 3) /
                720)) +
      grid.falseNorthing,
  };
}

// The origin is the upper-left corner of cell (0, 0), not its center.
export interface Grid {
  originX: number;
  originY: number;
  width: number;
  height: number;
  cellMeters: number;
  projection: Tmerc;
}

// Interleaved cell-corner x east, y south from the origin; unclosed.
export type Ring = Float64Array;

// Twice the signed area in cells: positive for an outer ring, negative for a hole.
export function ringDoubleArea(ring: Ring): number {
  let total = 0;
  for (let at = 0, previous = ring.length - 2; at < ring.length; at += 2) {
    total += ring[previous] * ring[at + 1] - ring[at] * ring[previous + 1];
    previous = at;
  }
  return total;
}

// East, south, west, north.
const STEP_X = [1, 0, -1, 0];
const STEP_Y = [0, 1, 0, -1];

// Walks cell corners, so the rings' union is exactly the mask; 4-connected, so no ring pinches.
export function traceRings(
  mask: Uint8Array,
  width: number,
  height: number,
): Ring[] {
  const corners = (width + 1) * (height + 1);
  // Two outgoing edges per corner at most, held as direction + 1 so 0 reads as "none".
  const first = new Uint8Array(corners);
  const second = new Uint8Array(corners);
  const add = (x: number, y: number, direction: number): void => {
    const corner = y * (width + 1) + x;
    if (first[corner] === 0) {
      first[corner] = direction + 1;
    } else {
      second[corner] = direction + 1;
    }
  };
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      if (mask[row * width + column] === 0) {
        continue;
      }
      if (row === 0 || mask[(row - 1) * width + column] === 0) {
        add(column, row, 0); // along the top, east
      }
      if (column + 1 === width || mask[row * width + column + 1] === 0) {
        add(column + 1, row, 1); // down the right side, south
      }
      if (row + 1 === height || mask[(row + 1) * width + column] === 0) {
        add(column + 1, row + 1, 2); // along the bottom, west
      }
      if (column === 0 || mask[row * width + column - 1] === 0) {
        add(column, row + 1, 3); // up the left side, north
      }
    }
  }

  const rings: Ring[] = [];
  const walk: number[] = [];
  for (let start = 0; start < corners; start++) {
    while (first[start] !== 0) {
      walk.length = 0;
      let x = start % (width + 1);
      let y = (start - (start % (width + 1))) / (width + 1);
      let corner = start;
      let heading = -1;
      do {
        // At a two-edge corner, the tightest (right, y-down) turn stays on the cell just passed.
        let direction = first[corner] - 1;
        if (second[corner] !== 0) {
          const other = second[corner] - 1;
          const turn =
            STEP_X[heading] * STEP_Y[direction] -
            STEP_Y[heading] * STEP_X[direction];
          if (turn < 0) {
            first[corner] = second[corner];
            second[corner] = direction + 1;
            direction = other;
          }
        }
        first[corner] = second[corner];
        second[corner] = 0;
        walk.push(x, y);
        heading = direction;
        x += STEP_X[direction];
        y += STEP_Y[direction];
        corner = y * (width + 1) + x;
      } while (corner !== start);
      rings.push(Float64Array.from(walk));
    }
  }
  return rings;
}

// Drops the vertices in the middle of a straight run.
function dropCollinear(ring: Ring): Ring {
  const kept: number[] = [];
  const count = ring.length / 2;
  for (let at = 0; at < count; at++) {
    const previous = (at + count - 1) % count;
    const next = (at + 1) % count;
    const beforeX = ring[at * 2] - ring[previous * 2];
    const beforeY = ring[at * 2 + 1] - ring[previous * 2 + 1];
    const afterX = ring[next * 2] - ring[at * 2];
    const afterY = ring[next * 2 + 1] - ring[at * 2 + 1];
    if (beforeX * afterY - beforeY * afterX !== 0) {
      kept.push(ring[at * 2], ring[at * 2 + 1]);
    }
  }
  return Float64Array.from(kept);
}

// Iterative, so a ring of a hundred thousand vertices can't overflow the stack.
function decimate(
  ring: Ring,
  keep: Uint8Array,
  from: number,
  to: number,
  tolerance: number,
): void {
  const stack: number[] = [from, to];
  while (stack.length > 0) {
    const last = stack.pop() as number;
    const start = stack.pop() as number;
    if (last - start < 2) {
      continue;
    }
    const startX = ring[start * 2];
    const startY = ring[start * 2 + 1];
    const spanX = ring[last * 2] - startX;
    const spanY = ring[last * 2 + 1] - startY;
    const span = Math.hypot(spanX, spanY);
    let worst = 0;
    let at = -1;
    for (let index = start + 1; index < last; index++) {
      const offsetX = ring[index * 2] - startX;
      const offsetY = ring[index * 2 + 1] - startY;
      // The segment is a point whenever a chain closes on itself.
      const distance =
        span === 0
          ? Math.hypot(offsetX, offsetY)
          : Math.abs(offsetX * spanY - offsetY * spanX) / span;
      if (distance > worst) {
        worst = distance;
        at = index;
      }
    }
    if (worst > tolerance) {
      keep[at] = 1;
      stack.push(start, at, at, last);
    }
  }
}

// Anchored at the lowest-leftmost corner (on the hull) and the vertex farthest from it.
export function simplifyRing(ring: Ring, tolerance: number): Ring {
  const straight = dropCollinear(ring);
  const count = straight.length / 2;
  if (count < 4 || tolerance <= 0) {
    return straight;
  }
  let anchor = 0;
  for (let at = 1; at < count; at++) {
    if (
      straight[at * 2 + 1] < straight[anchor * 2 + 1] ||
      (straight[at * 2 + 1] === straight[anchor * 2 + 1] &&
        straight[at * 2] < straight[anchor * 2])
    ) {
      anchor = at;
    }
  }
  const rotated = new Float64Array(straight.length);
  for (let at = 0; at < count; at++) {
    const source = (anchor + at) % count;
    rotated[at * 2] = straight[source * 2];
    rotated[at * 2 + 1] = straight[source * 2 + 1];
  }
  let far = 0;
  let farthest = -1;
  for (let at = 1; at < count; at++) {
    const distance = Math.hypot(
      rotated[at * 2] - rotated[0],
      rotated[at * 2 + 1] - rotated[1],
    );
    if (distance > farthest) {
      farthest = distance;
      far = at;
    }
  }
  const keep = new Uint8Array(count);
  keep[0] = 1;
  keep[far] = 1;
  decimate(rotated, keep, 0, far, tolerance);
  // The second chain wraps past the last index, so it is decimated against a rotated copy.
  const tail = new Float64Array(rotated.length + 2);
  tail.set(rotated);
  tail[rotated.length] = rotated[0];
  tail[rotated.length + 1] = rotated[1];
  const tailKeep = new Uint8Array(count + 1);
  decimate(tail, tailKeep, far, count, tolerance);
  for (let at = far + 1; at < count; at++) {
    keep[at] ||= tailKeep[at];
  }
  const kept: number[] = [];
  for (let at = 0; at < count; at++) {
    if (keep[at] === 1) {
      kept.push(rotated[at * 2], rotated[at * 2 + 1]);
    }
  }
  return Float64Array.from(kept);
}

// Even-odd, the rule the tiler fills these polygons with.
function inside(ring: Ring, x: number, y: number): boolean {
  let odd = false;
  for (let at = 0, previous = ring.length - 2; at < ring.length; at += 2) {
    const currentY = ring[at + 1];
    const previousY = ring[previous + 1];
    if (currentY > y !== previousY > y) {
      const crossing =
        ring[previous] +
        ((y - previousY) / (currentY - previousY)) *
          (ring[at] - ring[previous]);
      if (x < crossing) {
        odd = !odd;
      }
    }
    previous = at;
  }
  return odd;
}

export interface MaskPolygons {
  // In cell coordinates, outer ring first.
  polygons: Ring[][];
  cells: number; // before any drop
  dropped: number;
  droppedCells: number;
}

// Holes nest by containment, cheap at a few hundred rings a tile, rather than component labels.
export function polygonsOfMask(
  mask: Uint8Array,
  width: number,
  height: number,
  toleranceCells: number,
  minimumCells: number,
): MaskPolygons {
  const rings = traceRings(mask, width, height);
  const outers: { ring: Ring; area: number; holes: Ring[] }[] = [];
  const holes: Ring[] = [];
  for (const ring of rings) {
    const area = ringDoubleArea(ring);
    if (area > 0) {
      outers.push({ ring, area: area / 2, holes: [] });
    } else if (area < 0) {
      holes.push(ring);
    }
  }
  for (const hole of holes) {
    let best = -1;
    let bestArea = Number.POSITIVE_INFINITY;
    for (let at = 0; at < outers.length; at++) {
      // Smallest container, or a hole in an island in a lake would go to the lake's outer ring.
      if (
        outers[at].area < bestArea &&
        inside(outers[at].ring, hole[0], hole[1])
      ) {
        best = at;
        bestArea = outers[at].area;
      }
    }
    if (best >= 0) {
      outers[best].holes.push(hole);
    }
  }

  const polygons: Ring[][] = [];
  let cells = 0;
  let dropped = 0;
  let droppedCells = 0;
  for (const outer of outers) {
    let area = outer.area;
    for (const hole of outer.holes) {
      area += ringDoubleArea(hole) / 2;
    }
    cells += area;
    if (area < minimumCells) {
      dropped += 1;
      droppedCells += area;
      continue;
    }
    const simplified = [simplifyRing(outer.ring, toleranceCells)];
    for (const hole of outer.holes) {
      const ring = simplifyRing(hole, toleranceCells);
      if (ring.length >= 6) {
        simplified.push(ring);
      }
    }
    if (simplified[0].length >= 6) {
      polygons.push(simplified);
    } else {
      dropped += 1;
      droppedCells += area;
    }
  }
  return { polygons, cells, dropped, droppedCells };
}

// Closed, as an ArcGIS ring arrives, so the two sources encode alike.
export function ringToCoords(
  ring: Ring,
  grid: Grid,
  offsetX: number,
  offsetY: number,
): Coord[] {
  const coords: Coord[] = [];
  for (let at = 0; at < ring.length; at += 2) {
    coords.push(
      inverseTmerc(
        grid.projection,
        grid.originX + (offsetX + ring[at]) * grid.cellMeters,
        grid.originY - (offsetY + ring[at + 1]) * grid.cellMeters,
      ),
    );
  }
  coords.push(coords[0]);
  return coords;
}

// The one raster format the tiler's mosaic reader takes, with only the tags it reads.
const TIFF_HEADER_BYTES = 8;
const TIFF_ENTRY_BYTES = 12;
const TIFF_TYPE_SHORT = 3;
const TIFF_TYPE_LONG = 4;
const TIFF_TYPE_DOUBLE = 12;

export function encodeFloatTiff(
  values: Float32Array,
  width: number,
  height: number,
  originX: number,
  originY: number,
  cellMeters: number,
): Uint8Array {
  const entries: [number, number, number, number[]][] = [
    [256, TIFF_TYPE_LONG, 1, [width]], // ImageWidth
    [257, TIFF_TYPE_LONG, 1, [height]], // ImageLength
    [258, TIFF_TYPE_SHORT, 1, [32]], // BitsPerSample
    [259, TIFF_TYPE_SHORT, 1, [1]], // Compression: none
    [262, TIFF_TYPE_SHORT, 1, [1]], // PhotometricInterpretation: black is zero
    [273, TIFF_TYPE_LONG, 1, [0]], // StripOffsets, filled in below
    [277, TIFF_TYPE_SHORT, 1, [1]], // SamplesPerPixel
    [278, TIFF_TYPE_LONG, 1, [height]], // RowsPerStrip: one strip
    [279, TIFF_TYPE_LONG, 1, [width * height * 4]], // StripByteCounts
    [284, TIFF_TYPE_SHORT, 1, [1]], // PlanarConfiguration: chunky
    [339, TIFF_TYPE_SHORT, 1, [3]], // SampleFormat: IEEE floating point
    [33550, TIFF_TYPE_DOUBLE, 3, [cellMeters, cellMeters, 0]], // ModelPixelScale
    [33922, TIFF_TYPE_DOUBLE, 6, [0, 0, 0, originX, originY, 0]], // ModelTiepoint
  ];
  const directory = TIFF_HEADER_BYTES;
  const extras = directory + 2 + entries.length * TIFF_ENTRY_BYTES + 4;
  let extra = extras;
  for (const [, type, count] of entries) {
    if (type === TIFF_TYPE_DOUBLE) {
      extra += count * 8;
    }
  }
  const strip = extra;
  const bytes = new Uint8Array(strip + values.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0x4949, true); // little endian
  view.setUint16(2, 42, true);
  view.setUint32(4, directory, true);
  view.setUint16(directory, entries.length, true);
  let offset = directory + 2;
  let payload = extras;
  for (const [tag, type, count, value] of entries) {
    view.setUint16(offset, tag, true);
    view.setUint16(offset + 2, type, true);
    view.setUint32(offset + 4, count, true);
    if (type === TIFF_TYPE_DOUBLE) {
      view.setUint32(offset + 8, payload, true);
      for (const item of value) {
        view.setFloat64(payload, item, true);
        payload += 8;
      }
    } else if (type === TIFF_TYPE_SHORT) {
      view.setUint16(offset + 8, value[0], true);
    } else if (tag === 273) {
      view.setUint32(offset + 8, strip, true);
    } else {
      view.setUint32(offset + 8, value[0], true);
    }
    offset += TIFF_ENTRY_BYTES;
  }
  view.setUint32(offset, 0, true); // no second directory
  bytes.set(
    new Uint8Array(values.buffer, values.byteOffset, values.byteLength),
    strip,
  );
  return bytes;
}
