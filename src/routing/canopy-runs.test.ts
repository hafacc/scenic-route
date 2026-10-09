import { expect, test } from "bun:test";
import {
  coveredFraction,
  decodeCanopyRuns,
  edgeOrderHash,
  edgeRuns,
  edgeStretches,
  sameGraph,
} from "./canopy-runs";
import {
  CANOPY_RUNS_HEX,
  fixtureBuffer,
  GRAPH_KEY_HASH,
} from "./canopy-runs.fixture";
import type { RoutingGraph } from "./graph";

// The fixture's graph: four edges end to end, 0-1, 1-2, 2-3, 3-4.
const graphOf = (
  keyHash: string,
  pairs: [number, number][] = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
  ],
): RoutingGraph =>
  ({
    keyHash,
    edgeCount: pairs.length,
    edgeNodeA: Uint32Array.from(pairs, ([from]) => from),
    edgeNodeB: Uint32Array.from(pairs, ([, to]) => to),
  }) as unknown as RoutingGraph;

test("the header says which graph the runs were sampled along", () => {
  const runs = decodeCanopyRuns(fixtureBuffer());
  expect(runs.graphKeyHash).toBe(GRAPH_KEY_HASH);
  expect(runs.edgeCount).toBe(4);
  expect([...runs.edges]).toEqual([0, 1, 3]);
});

test("an artifact sampled along another graph is not this graph's", () => {
  const runs = decodeCanopyRuns(fixtureBuffer());
  expect(sameGraph(graphOf(GRAPH_KEY_HASH), runs)).toBe(true);
  expect(sameGraph(graphOf("0123456789abcdef"), runs)).toBe(false);
  // A graph whose version file could not be read matches nothing.
  expect(sameGraph(graphOf(""), runs)).toBe(false);
});

// The key space is blind to crossings and to edge order, and a record names its edge by index.
test("the same key space with its edges in another order, or one more, is another graph", () => {
  const runs = decodeCanopyRuns(fixtureBuffer());
  expect(edgeOrderHash(graphOf(GRAPH_KEY_HASH))).toBe(runs.edgeOrderHash);
  const reordered = graphOf(GRAPH_KEY_HASH, [
    [1, 2],
    [0, 1],
    [2, 3],
    [3, 4],
  ]);
  expect(sameGraph(reordered, runs)).toBe(false);
  const grown = graphOf(GRAPH_KEY_HASH, [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
    [4, 0],
  ]);
  expect(sameGraph(grown, runs)).toBe(false);
  const rewired = graphOf(GRAPH_KEY_HASH, [
    [0, 1],
    [1, 2],
    [2, 4],
    [3, 4],
  ]);
  expect(sameGraph(rewired, runs)).toBe(false);
});

test("a file cut short anywhere is refused, and never hangs the decode", () => {
  const whole = CANOPY_RUNS_HEX.length / 2;
  for (const bytes of [0, 3, 35, 36, 37, 40, 47, whole - 4, whole - 1]) {
    expect(
      () =>
        decodeCanopyRuns(fixtureBuffer(CANOPY_RUNS_HEX.slice(0, bytes * 2))),
      `${bytes} bytes`,
    ).toThrow();
  }
  // Bytes past the last record are as wrong as bytes missing from it.
  expect(() => decodeCanopyRuns(fixtureBuffer(`${CANOPY_RUNS_HEX}00`))).toThrow(
    "do not fill the file",
  );
});

test("a header whose counts its records do not bear out is refused", () => {
  const hex = (at: number, bytes: string): string =>
    CANOPY_RUNS_HEX.slice(0, at * 2) +
    bytes +
    CANOPY_RUNS_HEX.slice((at + bytes.length / 2) * 2);
  // Two records claimed of three, a run count one too many, and a graph of three edges for edge 3.
  expect(() => decodeCanopyRuns(fixtureBuffer(hex(12, "02000000")))).toThrow();
  expect(() => decodeCanopyRuns(fixtureBuffer(hex(24, "07000000")))).toThrow();
  expect(() => decodeCanopyRuns(fixtureBuffer(hex(8, "03000000")))).toThrow(
    "names edge 3",
  );
  expect(() => decodeCanopyRuns(fixtureBuffer(hex(12, "ffffff7f")))).toThrow();
});

test("a covered edge reads back as the samples under a crown", () => {
  const runs = decodeCanopyRuns(fixtureBuffer());
  expect(edgeRuns(runs, 0)).toEqual({
    samples: 50,
    tailJoined: true,
    starts: [10, 23, 46],
    counts: [10, 7, 4],
    drawn: [true, true, true],
    joined: [false, true, false],
  });
  expect(edgeRuns(runs, 1)).toEqual({
    samples: 50,
    tailJoined: false,
    starts: [0, 20],
    counts: [4, 2],
    drawn: [true, false],
    joined: [true, false],
  });
  // Past 127 a count takes a second varint byte.
  expect(edgeRuns(runs, 2)).toEqual({
    samples: 300,
    tailJoined: false,
    starts: [150],
    counts: [150],
    drawn: [true],
    joined: [false],
  });
});

test("the runs are the share the router's canopy byte was baked from", () => {
  const runs = decodeCanopyRuns(fixtureBuffer());
  expect(coveredFraction(edgeRuns(runs, 0))).toBe(21 / 50);
  expect(coveredFraction(edgeRuns(runs, 1))).toBe(6 / 50);
  expect(coveredFraction(edgeRuns(runs, 2))).toBe(0.5);
});

test("a stretch takes in the gaps the tiler bridged and leaves out a crown too short to draw", () => {
  const runs = decodeCanopyRuns(fixtureBuffer());
  // The first two runs are one stretch; the third runs on to the edge's end node.
  expect(edgeStretches(edgeRuns(runs, 0))).toEqual([
    { t0: 10 / 50, t1: 30 / 50 },
    { t0: 46 / 50, t1: 1 },
  ]);
  expect(edgeStretches(edgeRuns(runs, 1))).toEqual([{ t0: 0, t1: 4 / 50 }]);
  expect(edgeStretches(edgeRuns(runs, 2))).toEqual([{ t0: 0.5, t1: 1 }]);
});

test("an end joined through its node is drawn on to it across the gap", () => {
  // The fixture's first edge, with its first run joined back to node 0 and its last stopping short.
  const joined = CANOPY_RUNS_HEX.replace("32070a29", "32070a2b").replace(
    "1011",
    "0f11",
  );
  const runs = decodeCanopyRuns(fixtureBuffer(joined));
  expect(edgeStretches(edgeRuns(runs, 0))).toEqual([
    { t0: 0, t1: 30 / 50 },
    { t0: 45 / 50, t1: 1 },
  ]);
});

test("another format's file is refused", () => {
  expect(() =>
    decodeCanopyRuns(fixtureBuffer(CANOPY_RUNS_HEX.replace("4352", "5352"))),
  ).toThrow("not a v2 canopy-runs file");
  expect(() =>
    decodeCanopyRuns(
      fixtureBuffer(CANOPY_RUNS_HEX.replace("4e0200", "4e0100")),
    ),
  ).toThrow("not a v2 canopy-runs file");
});

test("a record no edge could have is refused: no samples, no runs, or a run past the edge's end", () => {
  const swap = (from: string, to: string): ArrayBuffer => {
    expect(CANOPY_RUNS_HEX.split(from).length).toBe(2);
    return fixtureBuffer(CANOPY_RUNS_HEX.replace(from, to));
  };
  // The first record is edge 0, 50 samples, three runs and a joined tail: 00 32 07, then 0a 29.
  expect(() => decodeCanopyRuns(swap("0032070a29", "0000070a29"))).toThrow(
    "3 runs of 0 samples",
  );
  // A run count of 2^31 and more, which a 32-bit shift would have read as none or as negative.
  expect(() =>
    decodeCanopyRuns(swap("0032070a29", "0032ffffffff1f0a29")),
  ).toThrow("runs of 50 samples");
  // The last run of the first edge, 4 samples from 46, grown to run past sample 50.
  expect(() => decodeCanopyRuns(swap("1011", "1015"))).toThrow(
    "runs to sample 51 of 50",
  );
  // A run of no samples at all.
  expect(() => decodeCanopyRuns(swap("0a29", "0a01"))).toThrow();
});
