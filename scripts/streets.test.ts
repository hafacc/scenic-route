import { expect, test } from "bun:test";
import { CSCL_NOT_STREETS, dropNotStreets } from "./streets";

test("Floyd Bennett's runway 06/24 is no street, and Aviation Road on runway 15/33 still is", () => {
  expect(CSCL_NOT_STREETS.has(133944)).toBe(true);
  // Aviation Road is the park's open road, laid on the old runway 15/33.
  for (const aviationRoad of [133945, 167382, 167383]) {
    expect(CSCL_NOT_STREETS.has(aviationRoad)).toBe(false);
  }
});

test("every excluded segment says why", () => {
  for (const reason of CSCL_NOT_STREETS.values()) {
    expect(reason.length).toBeGreaterThan(0);
  }
});

test("the runway row is dropped and Aviation Road's is kept", () => {
  const rows = [{ physicalid: "133944" }, { physicalid: "167382" }];
  expect(dropNotStreets(rows)).toEqual([{ physicalid: "167382" }]);
});

test("a fetch that no longer carries a listed segment fails rather than keep the entry stale", () => {
  expect(() => dropNotStreets([{ physicalid: "167382" }])).toThrow(/133944/);
});
