import { expect, test } from "bun:test";
import { keptStopTimes } from "./gtfs";

const KEPT = new Set(["rail-1", "rail,2"]);
const ids = (rows: { trip_id?: string }[]): (string | undefined)[] =>
  rows.map((row) => row.trip_id);

test("only the kept trips' stop times are parsed", () => {
  const rows = keptStopTimes(
    "trip_id,stop_id\nrail-1,A\nbus-9,B\nrail-1,C\n",
    KEPT,
  );
  expect(rows).toEqual([
    { trip_id: "rail-1", stop_id: "A" },
    { trip_id: "rail-1", stop_id: "C" },
  ]);
});

test("CRLF line ends and a BOM read like plain text", () => {
  const rows = keptStopTimes(
    "﻿trip_id,stop_id\r\nrail-1,A\r\nbus-9,B\r\n",
    KEPT,
  );
  expect(rows).toEqual([{ trip_id: "rail-1", stop_id: "A" }]);
});

test("a quoted trip id with a comma in it is one cell", () => {
  const rows = keptStopTimes(
    'stop_id,trip_id,stop_headsign\nA,"rail,2","Van Cortlandt, Bronx"\nB,"bus-9",x\n',
    KEPT,
  );
  expect(ids(rows)).toEqual(["rail,2"]);
  expect(rows[0].stop_headsign).toBe("Van Cortlandt, Bronx");
});

test("a trip id in the last column still filters", () => {
  const rows = keptStopTimes(
    "stop_id,stop_sequence,trip_id\r\nA,1,rail-1\r\nB,2,bus-9\r\n",
    KEPT,
  );
  expect(ids(rows)).toEqual(["rail-1"]);
});

test("a table with no trip_id column is read whole", () => {
  const rows = keptStopTimes("stop_id,arrival_time\nA,06:00:00\n", KEPT);
  expect(rows).toEqual([{ stop_id: "A", arrival_time: "06:00:00" }]);
});
