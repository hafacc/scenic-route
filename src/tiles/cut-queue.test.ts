import { expect, test } from "bun:test";
import { type CutJob, CutQueue } from "./cut-queue";

// A job with `cuts` pieces of work in it, logging what happens to it.
function job(name: string, cuts: number, log: string[]): CutJob {
  let left = cuts;
  return {
    prepare() {
      if (left === 0) {
        return false;
      }
      left -= 1;
      log.push(`cut ${name}`);
      return left > 0;
    },
    send() {
      log.push(`send ${name}`);
    },
  };
}

// Spent after `steps` checks, as a frame's clock would be.
function budget(steps: number): () => boolean {
  let checks = 0;
  return () => {
    checks += 1;
    return checks > steps;
  };
}

const never = (): boolean => false;

test("with time to spare every tile is cut and sent, oldest first", () => {
  const log: string[] = [];
  const queue = new CutQueue<string>();
  queue.add("a", job("a", 2, log));
  queue.add("b", job("b", 0, log));
  queue.frame(never);
  expect(log).toEqual(["cut a", "cut a", "send a", "send b"]);
  expect(queue.size).toBe(0);
});

test("a tile caught mid-cut keeps its place and is finished first in the next frame", () => {
  const log: string[] = [];
  const queue = new CutQueue<string>();
  queue.add("a", job("a", 3, log));
  queue.add("b", job("b", 1, log));
  queue.frame(budget(0));
  expect(log).toEqual(["cut a"]);
  expect(queue.size).toBe(2);
  queue.frame(never);
  expect(log).toEqual(["cut a", "cut a", "cut a", "send a", "cut b", "send b"]);
});

test("a tile whose last cut spends the frame is sent in the next, not lost", () => {
  const log: string[] = [];
  const queue = new CutQueue<string>();
  queue.add("a", job("a", 1, log));
  queue.frame(budget(0));
  expect(log).toEqual(["cut a"]);
  expect(queue.size).toBe(1);
  queue.frame(never);
  expect(log).toEqual(["cut a", "send a"]);
});

test("a tile unloaded before its turn is never cut or sent, and a cleared queue does nothing", () => {
  const log: string[] = [];
  const queue = new CutQueue<string>();
  queue.add("a", job("a", 1, log));
  queue.add("b", job("b", 1, log));
  queue.drop("a");
  queue.frame(never);
  expect(log).toEqual(["cut b", "send b"]);
  queue.add("c", job("c", 1, log));
  queue.clear();
  queue.frame(never);
  expect(log).toEqual(["cut b", "send b"]);
});

test("a tile queued again under a new source is cut from that one alone", () => {
  const log: string[] = [];
  const queue = new CutQueue<string>();
  queue.add("a", job("old", 2, log));
  queue.add("a", job("new", 1, log));
  queue.frame(never);
  expect(log).toEqual(["cut new", "send new"]);
});

test("a tile added while the frame runs is reached in the same frame if time allows", () => {
  const log: string[] = [];
  const queue = new CutQueue<string>();
  queue.add("a", {
    prepare: () => false,
    send() {
      log.push("send a");
      queue.add("b", job("b", 1, log));
    },
  });
  queue.frame(never);
  expect(log).toEqual(["send a", "cut b", "send b"]);
});
