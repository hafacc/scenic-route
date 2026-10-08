import { expect, test } from "bun:test";
import type { DoneMessage, DrawMessage, ShadeParams } from "./protocol";
import { TileQueue } from "./tile-queue";

// Each load waits on its own resolver, so a test can land a repaint mid-load.
interface Load {
  tau: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

function harness() {
  const loads: Load[] = [];
  const paints: number[] = [];
  const done: DoneMessage[] = [];
  const queue = new TileQueue(
    (message, current) => {
      const { tau } = message.params as ShadeParams;
      return new Promise<void>((resolve, reject) => {
        loads.push({ tau, resolve, reject });
      }).then(() => {
        if (current()) {
          paints.push(tau);
        }
      });
    },
    (message) => {
      done.push(message);
    },
  );
  const draw = (tileKey: number, tau: number): void => {
    queue.draw({
      type: "draw",
      tileKey,
      coords: { x: 0, y: 0, z: 15 },
      ratio: 1,
      params: params(tau),
      canvas: null as unknown as OffscreenCanvas,
    } satisfies DrawMessage);
  };
  return { queue, loads, paints, done, draw };
}

function params(tau: number): ShadeParams {
  return { kind: "shade", tau } as ShadeParams;
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 10; turn++) {
    await Promise.resolve();
  }
}

test("a repaint redraws a painted tile in place, without a second done", async () => {
  const { queue, loads, paints, done, draw } = harness();
  draw(1, 0.1);
  loads[0].resolve();
  await flush();
  expect(paints).toEqual([0.1]);
  expect(done).toEqual([{ type: "done", tileKey: 1, error: undefined }]);

  queue.repaint([1], params(0.2));
  loads[1].resolve();
  await flush();

  expect(paints).toEqual([0.1, 0.2]);
  expect(done).toHaveLength(1);
});

// The stale load must not paint, and Leaflet hears once, after the newest params land.
test("a repaint mid-load redoes the load before painting", async () => {
  const { queue, loads, paints, done, draw } = harness();
  draw(2, 0.1);
  queue.repaint([2], params(0.3));
  loads[0].resolve();
  await flush();
  expect(paints).toEqual([]);
  expect(done).toEqual([]);

  loads[1].resolve();
  await flush();

  expect(loads.map(({ tau }) => tau)).toEqual([0.1, 0.3]);
  expect(paints).toEqual([0.3]);
  expect(done).toEqual([{ type: "done", tileKey: 2, error: undefined }]);
});

test("a superseded load's failure still lets the newest params paint", async () => {
  const { queue, loads, paints, done, draw } = harness();
  draw(3, 0.1);
  queue.repaint([3], params(0.4));
  loads[0].reject(new Error("stale"));
  await flush();

  loads[1].resolve();
  await flush();

  expect(paints).toEqual([0.4]);
  expect(done).toEqual([{ type: "done", tileKey: 3, error: undefined }]);
});

test("the newest load's failure reaches Leaflet", async () => {
  const { loads, paints, done, draw } = harness();
  draw(4, 0.1);
  loads[0].reject(new Error("offline"));
  await flush();

  expect(paints).toEqual([]);
  expect(done).toEqual([{ type: "done", tileKey: 4, error: "offline" }]);
});

test("a dropped tile is not repainted", async () => {
  const { queue, loads, paints, draw } = harness();
  draw(5, 0.1);
  loads[0].resolve();
  await flush();
  queue.cancel(5);

  queue.repaint([5], params(0.2));
  await flush();

  expect(loads).toHaveLength(1);
  expect(paints).toEqual([0.1]);
});

// A theme flip on tiles that each carry their own lines: nothing new to send, everything to redraw.
test("a repaint with no params redraws each tile from the params it was sent with", async () => {
  const { queue, loads, paints, done, draw } = harness();
  draw(1, 0.1);
  draw(2, 0.7);
  loads[0].resolve();
  loads[1].resolve();
  await flush();

  queue.repaint([1, 2, 9]);
  loads[2].resolve();
  loads[3].resolve();
  await flush();

  expect(paints).toEqual([0.1, 0.7, 0.1, 0.7]);
  expect(done).toHaveLength(2);
});
