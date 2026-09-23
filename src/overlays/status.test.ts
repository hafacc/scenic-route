import { expect, test } from "bun:test";
import type L from "leaflet";
import type { OverlayId } from "./registry";
import { unreachableLayers, watchLayerStatus } from "./status";

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
