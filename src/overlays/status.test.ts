import { expect, test } from "bun:test";
import type L from "leaflet";
import type { OverlayId } from "./registry";
import { loadLayerData, unreachableLayers, watchLayerStatus } from "./status";

type Handler = () => void;

function fakeLayer(): L.GridLayer & { fire: (event: string) => void } {
  const handlers = new Map<string, Set<Handler>>();
  return {
    on(event: string, handler: Handler) {
      const set = handlers.get(event) ?? new Set<Handler>();
      set.add(handler);
      handlers.set(event, set);
      return this;
    },
    off(event: string, handler: Handler) {
      handlers.get(event)?.delete(handler);
      return this;
    },
    fire(event: string) {
      for (const handler of handlers.get(event) ?? []) {
        handler();
      }
    },
  } as unknown as L.GridLayer & { fire: (event: string) => void };
}

const reachable = (overlay: OverlayId): boolean =>
  !unreachableLayers().has(overlay);

test("one failed tile among many condemns the whole load cycle", () => {
  const layer = fakeLayer();
  const detach = watchLayerStatus(layer, "historic");

  layer.fire("loading");
  layer.fire("tileload");
  layer.fire("tileerror");
  layer.fire("tileload");
  layer.fire("load");
  expect(reachable("historic")).toBe(false);

  detach();
});

test("the next clean load cycle clears the layer", () => {
  const layer = fakeLayer();
  const detach = watchLayerStatus(layer, "industrial");

  layer.fire("loading");
  layer.fire("tileerror");
  layer.fire("load");
  expect(reachable("industrial")).toBe(false);

  // The error count resets with the cycle, not with the layer.
  layer.fire("loading");
  layer.fire("tileload");
  layer.fire("load");
  expect(reachable("industrial")).toBe(true);

  detach();
});

test("a layer taken off the map reports nothing", () => {
  const layer = fakeLayer();
  const detach = watchLayerStatus(layer, "subway");

  layer.fire("loading");
  layer.fire("tileerror");
  layer.fire("load");
  expect(reachable("subway")).toBe(false);

  detach();
  expect(reachable("subway")).toBe(true);
});

// Canopy and genus each have two map layers behind one row, so a healthy one mustn't mask the other.
test("one failing layer badges the row its healthy sibling shares", () => {
  const raster = fakeLayer();
  const lines = fakeLayer();
  const detachRaster = watchLayerStatus(raster, "canopy");
  const detachLines = watchLayerStatus(lines, "canopy");

  raster.fire("loading");
  raster.fire("tileerror");
  raster.fire("load");
  lines.fire("loading");
  lines.fire("tileload");
  lines.fire("load");
  expect(reachable("canopy")).toBe(false);

  raster.fire("loading");
  raster.fire("tileload");
  raster.fire("load");
  expect(reachable("canopy")).toBe(true);

  detachRaster();
  detachLines();
});

// A layer drawn from one file has no tiles to fail, so its load is what gets reported.

const settled = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn++) {
    await Promise.resolve();
  }
};

test("a file that fails to load marks its layer unreachable, and a load once online clears it", async () => {
  const network = new EventTarget();
  let online = false;
  const used: string[] = [];
  const stop = loadLayerData(
    "scaffolding",
    () =>
      online ? Promise.resolve("data") : Promise.reject(new Error("offline")),
    (data) => used.push(data),
    network,
  );
  await settled();
  expect(reachable("scaffolding")).toBe(false);
  expect(used).toEqual([]);

  online = true;
  network.dispatchEvent(new Event("online"));
  await settled();
  expect(reachable("scaffolding")).toBe(true);
  expect(used).toEqual(["data"]);
  stop();
});

test("a load that succeeds reports nothing wrong, and one that fails after removal reports nothing at all", async () => {
  const network = new EventTarget();
  const used: string[] = [];
  const stop = loadLayerData(
    "scaffolding",
    () => Promise.resolve("data"),
    (data) => used.push(data),
    network,
  );
  await settled();
  expect(reachable("scaffolding")).toBe(true);
  expect(used).toEqual(["data"]);
  stop();

  const gone = loadLayerData(
    "scaffolding",
    () => Promise.reject(new Error("gone")),
    () => used.push("never"),
    network,
  );
  gone();
  await settled();
  expect(reachable("scaffolding")).toBe(true);
  // Removed, it no longer listens for the network coming back.
  network.dispatchEvent(new Event("online"));
  await settled();
  expect(used).toEqual(["data"]);
});

test("a removed layer's failure is forgotten: removal is not evidence about reachability", async () => {
  const network = new EventTarget();
  const stop = loadLayerData(
    "scaffolding",
    () => Promise.reject(new Error("offline")),
    () => {},
    network,
  );
  await settled();
  expect(reachable("scaffolding")).toBe(false);
  stop();
  expect(reachable("scaffolding")).toBe(true);
});

// Loads whose settling the test controls, so their order can be chosen.
function deferredLoads(): {
  load: () => Promise<string>;
  settle: (attempt: number, data: string | null) => Promise<void>;
  count: () => number;
} {
  const waiting: {
    resolve: (data: string) => void;
    reject: (error: Error) => void;
  }[] = [];
  return {
    load: () =>
      new Promise<string>((resolve, reject) => {
        waiting.push({ resolve, reject });
      }),
    async settle(attempt, data) {
      if (data === null) {
        waiting[attempt].reject(new Error("failed"));
      } else {
        waiting[attempt].resolve(data);
      }
      await settled();
    },
    count: () => waiting.length,
  };
}

test("coming back online after a load that succeeded loads nothing again", async () => {
  const network = new EventTarget();
  const loads = deferredLoads();
  const used: string[] = [];
  const stop = loadLayerData(
    "scaffolding",
    loads.load,
    (data) => used.push(data),
    network,
  );
  await loads.settle(0, "first");
  network.dispatchEvent(new Event("online"));
  network.dispatchEvent(new Event("online"));
  await settled();
  expect(loads.count()).toBe(1);
  expect(used).toEqual(["first"]);
  stop();
});

test("coming online while the first load is in flight starts no second one", async () => {
  const network = new EventTarget();
  const loads = deferredLoads();
  const used: string[] = [];
  const stop = loadLayerData(
    "scaffolding",
    loads.load,
    (data) => used.push(data),
    network,
  );
  network.dispatchEvent(new Event("online"));
  await settled();
  expect(loads.count()).toBe(1);
  await loads.settle(0, "only");
  expect(used).toEqual(["only"]);
  stop();
});

test("a retry is the one that counts, whichever of it and the attempt before settles last", async () => {
  const network = new EventTarget();
  const used: string[] = [];
  // A load already given up on answers late; its success must not land over the retry.
  let calls = 0;
  const late: { resolve: (data: string) => void }[] = [];
  const load = (): Promise<string> => {
    calls += 1;
    if (calls === 1) {
      return Promise.reject(new Error("offline"));
    }
    return new Promise<string>((resolve) => {
      late.push({ resolve });
    });
  };
  const stop = loadLayerData(
    "scaffolding",
    load,
    (data) => used.push(data),
    network,
  );
  await settled();
  expect(reachable("scaffolding")).toBe(false);
  network.dispatchEvent(new Event("online"));
  await settled();
  expect(calls).toBe(2);
  // Still pending: a second signal starts nothing more.
  network.dispatchEvent(new Event("online"));
  await settled();
  expect(calls).toBe(2);
  late[0].resolve("retry");
  await settled();
  expect(used).toEqual(["retry"]);
  expect(reachable("scaffolding")).toBe(true);
  stop();
});

test("a load that settles after its layer is gone is neither used nor reported", async () => {
  const network = new EventTarget();
  const loads = deferredLoads();
  const used: string[] = [];
  const stop = loadLayerData(
    "scaffolding",
    loads.load,
    (data) => used.push(data),
    network,
  );
  stop();
  await loads.settle(0, "too late");
  expect(used).toEqual([]);
  expect(reachable("scaffolding")).toBe(true);

  const failing = deferredLoads();
  const gone = loadLayerData("scaffolding", failing.load, () => {}, network);
  gone();
  await failing.settle(0, null);
  expect(reachable("scaffolding")).toBe(true);
  network.dispatchEvent(new Event("online"));
  await settled();
  expect(failing.count()).toBe(1);
});
