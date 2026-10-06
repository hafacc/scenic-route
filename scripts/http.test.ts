import { afterEach, expect, test } from "bun:test";
import { fetchBytes } from "./http";

const realFetch = globalThis.fetch;
const URL = "https://example.test/rows.csv";
const BODY = new TextEncoder().encode("a,b\n");

type Answer = () => Response | Promise<Response>;

// Answers in order, repeating the last, and counts the requests.
function answers(...queue: Answer[]): { calls: () => number } {
  let calls = 0;
  globalThis.fetch = (async () => {
    const answer = queue[Math.min(calls, queue.length - 1)];
    calls += 1;
    return await answer();
  }) as unknown as typeof fetch;
  return { calls: () => calls };
}

// Bun's own error for a connection reset, which p-retry doesn't list as a network error.
function dropped(): TypeError {
  return Object.assign(
    new TypeError("The socket connection was closed unexpectedly."),
    { code: "ECONNRESET" },
  );
}

function reset(): never {
  throw dropped();
}

// The headers arrive and the body dies, as data.sf.gov did 72 s into a download.
function cutShort(): Response {
  const body = new ReadableStream<Uint8Array>({
    pull: (controller) => controller.error(dropped()),
  });
  return new Response(body);
}

function timeout(): never {
  throw new DOMException("The operation timed out.", "TimeoutError");
}

const status =
  (code: number): Answer =>
  () =>
    new Response("no", { status: code });
const ok: Answer = () => new Response(BODY);

const retried = (attempts: number, log: number[] = []) => ({
  attempts,
  minTimeoutMs: 0,
  onFailedAttempt: ({ attemptNumber }: { attemptNumber: number }) => {
    log.push(attemptNumber);
  },
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("a download succeeds after transient failures", async () => {
  const log: number[] = [];
  const { calls } = answers(reset, cutShort, timeout, status(503), ok);
  expect(await fetchBytes(URL, retried(5, log))).toEqual(BODY);
  expect(calls()).toBe(5);
  expect(log).toEqual([1, 2, 3, 4]);
});

test("a rate limit is retried", async () => {
  const { calls } = answers(status(429), ok);
  expect(await fetchBytes(URL, retried(2))).toEqual(BODY);
  expect(calls()).toBe(2);
});

test("a download gives up after its attempts", async () => {
  const { calls } = answers(reset);
  await expect(fetchBytes(URL, retried(3))).rejects.toThrow(
    "The socket connection was closed unexpectedly.",
  );
  expect(calls()).toBe(3);
});

test("a 404 is not retried", async () => {
  const { calls } = answers(status(404), ok);
  await expect(fetchBytes(URL, retried(3))).rejects.toThrow("404");
  expect(calls()).toBe(1);
});
