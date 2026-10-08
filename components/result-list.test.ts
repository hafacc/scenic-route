import { afterAll, beforeAll, expect, test } from "bun:test";
import type { GeocodeResult } from "../src/geocode";
import type { FromSearchWorker } from "../src/search/protocol";
import {
  resultListKeyDown,
  type SearchAnswer,
  searchSoon,
} from "./result-list";

// Stands in for the search worker, answering when the test says so.
class FakeWorker {
  static last: FakeWorker | null = null;
  private listener: ((event: { data: FromSearchWorker }) => void) | null = null;
  constructor() {
    FakeWorker.last = this;
  }
  addEventListener(
    type: string,
    listener: (event: { data: FromSearchWorker }) => void,
  ): void {
    if (type === "message") {
      this.listener = listener;
    }
  }
  postMessage(): void {}
  terminate(): void {}
  reply(data: FromSearchWorker): void {
    this.listener?.({ data });
  }
}

const globals = globalThis as unknown as Record<string, unknown>;
const before = {
  Worker: globals.Worker,
  document: globals.document,
  window: globals.window,
};

beforeAll(() => {
  globals.Worker = FakeWorker;
  globals.document = { baseURI: "https://example.test/" };
  globals.window = globalThis;
});

afterAll(() => {
  globals.Worker = before.Worker;
  globals.document = before.document;
  globals.window = before.window;
});

function row(displayName: string): GeocodeResult {
  return {
    placeId: `place:${displayName}`,
    lat: 40.7,
    lng: -73.9,
    displayName,
    type: "place",
    exact: false,
  };
}

function press(key: string): KeyboardEvent {
  return { key, preventDefault: () => {} } as KeyboardEvent;
}

test("the arrows wrap, and from no active row enter the list at either end", () => {
  const rows = [row("one"), row("two"), row("three")];
  const move = (key: string, active: number) =>
    resultListKeyDown(press(key), rows, active, () => {});
  expect(move("ArrowDown", -1)).toBe(0);
  expect(move("ArrowUp", -1)).toBe(2);
  expect(move("ArrowUp", 0)).toBe(2);
  expect(move("ArrowUp", 2)).toBe(1);
  expect(move("ArrowDown", 2)).toBe(0);
  expect(resultListKeyDown(press("ArrowUp"), [], -1, () => {})).toBeNull();
});

test("an index that never arrives ends the loading notice with a failure", async () => {
  const { releaseNameIndex } = await import("../src/search/name-search");
  const answers: SearchAnswer[] = [];
  const cancel = searchSoon("katz", "nyc", (results) => {
    answers.push(results);
  });
  // Past the typing pause, the first answer says the index is still loading.
  await new Promise((resume) => setTimeout(resume, 350));
  expect(answers).toEqual([null]);
  const logged = console.error;
  console.error = () => {};
  FakeWorker.last?.reply({ type: "error", city: "nyc", message: "offline" });
  console.error = logged;
  await new Promise((resume) => setTimeout(resume, 0));
  expect(answers).toEqual([null, "failed"]);
  cancel();
  releaseNameIndex();
});
