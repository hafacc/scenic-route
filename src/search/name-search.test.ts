import { afterAll, beforeAll, expect, test } from "bun:test";
import type { FromSearchWorker, ToSearchWorker } from "./protocol";

// Stands in for the search worker: holds what it was sent and answers when the test says so.
class FakeWorker {
  static last: FakeWorker | null = null;
  readonly sent: ToSearchWorker[] = [];
  private listener: ((event: { data: FromSearchWorker }) => void) | null = null;
  private onError: (() => void) | null = null;
  constructor() {
    FakeWorker.last = this;
  }
  addEventListener(type: "error", listener: () => void): void;
  addEventListener(
    type: "message",
    listener: (event: { data: FromSearchWorker }) => void,
  ): void;
  addEventListener(
    type: string,
    listener: (event: { data: FromSearchWorker }) => void,
  ): void {
    if (type === "error") {
      this.onError = listener as () => void;
    } else {
      this.listener = listener;
    }
  }
  // What a script that 404s or throws on load does: one `error` event and no message, ever.
  fail(): void {
    this.onError?.();
  }
  postMessage(message: ToSearchWorker): void {
    this.sent.push(message);
  }
  terminate(): void {}
  reply(data: FromSearchWorker): void {
    this.listener?.({ data });
  }
}

const globals = globalThis as unknown as Record<string, unknown>;
const before = { Worker: globals.Worker, document: globals.document };

beforeAll(() => {
  globals.Worker = FakeWorker;
  globals.document = { baseURI: "https://example.test/" };
});

afterAll(() => {
  globals.Worker = before.Worker;
  globals.document = before.document;
});

function hit(name: string, lat: number, lng: number) {
  return {
    kind: "place" as const,
    name,
    label: "",
    lat,
    lng,
    meters: 0,
    at: true,
  };
}

test("two pins named together both get their names", async () => {
  const { reverseNameIndex, releaseNameIndex } = await import("./name-search");
  const start = reverseNameIndex("nyc", { lat: 40.758, lng: -73.9855 });
  const dest = reverseNameIndex("nyc", { lat: 40.7308, lng: -73.9973 });
  const worker = FakeWorker.last;
  if (!worker) {
    throw new Error("no worker was started");
  }
  worker.reply({ type: "ready", city: "nyc" });
  // Both wait on the index; a turn of the loop lets each post its question.
  await new Promise((resume) => setTimeout(resume, 0));
  const asks = worker.sent.filter((message) => message.type === "reverse");
  expect(asks).toHaveLength(2);
  // Answered newest first, so neither rides on the other's order.
  worker.reply({
    type: "reverse",
    id: asks[1].id,
    hit: hit("Washington Square Park", 40.7308, -73.9973),
  });
  worker.reply({
    type: "reverse",
    id: asks[0].id,
    hit: hit("Times Square", 40.758, -73.9855),
  });
  expect((await start)?.name).toBe("Times Square");
  expect((await dest)?.name).toBe("Washington Square Park");
  releaseNameIndex();
});

test("lookups still out when the index is dropped answer null", async () => {
  const { reverseNameIndex, warmNameIndex, releaseNameIndex } = await import(
    "./name-search"
  );
  // Held by a panel, so the lookups finishing doesn't release it first.
  warmNameIndex("nyc");
  const first = reverseNameIndex("nyc", { lat: 40.758, lng: -73.9855 });
  const second = reverseNameIndex("nyc", { lat: 40.7308, lng: -73.9973 });
  FakeWorker.last?.reply({ type: "ready", city: "nyc" });
  await new Promise((resume) => setTimeout(resume, 0));
  releaseNameIndex();
  expect(await first).toBeNull();
  expect(await second).toBeNull();
});

test("a worker that fails to load lets go of everything waiting on it", async () => {
  const { awaitNameIndex, reverseNameIndex, releaseNameIndex } = await import(
    "./name-search"
  );
  const loaded = awaitNameIndex("nyc");
  const name = reverseNameIndex("nyc", { lat: 40.758, lng: -73.9855 });
  const failed = FakeWorker.last;
  const logged = console.error;
  console.error = () => {};
  failed?.fail();
  console.error = logged;
  expect(await loaded).toBe(false);
  expect(await name).toBeNull();
  // The next ask starts a new worker rather than writing to the dead one.
  const again = awaitNameIndex("nyc");
  expect(FakeWorker.last).not.toBe(failed);
  FakeWorker.last?.reply({ type: "ready", city: "nyc" });
  expect(await again).toBe(true);
  releaseNameIndex();
});

test("a lookup already asked of a worker that then fails answers null", async () => {
  const { reverseNameIndex, warmNameIndex, releaseNameIndex } = await import(
    "./name-search"
  );
  warmNameIndex("nyc");
  const name = reverseNameIndex("nyc", { lat: 40.758, lng: -73.9855 });
  FakeWorker.last?.reply({ type: "ready", city: "nyc" });
  await new Promise((resume) => setTimeout(resume, 0));
  const logged = console.error;
  console.error = () => {};
  FakeWorker.last?.fail();
  console.error = logged;
  expect(await name).toBeNull();
  releaseNameIndex();
});
