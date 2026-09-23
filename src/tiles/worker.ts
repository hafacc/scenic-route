import { setBaseUrl } from "./base-url";
import { canopyRenderer } from "./canopy";
import { commercialRenderer } from "./commercial";
import { elevationRenderer } from "./elevation";
import { historicRenderer } from "./historic";
import { industrialRenderer } from "./industrial";
import { linesRenderer } from "./lines";
import { poiRenderer } from "./poi";
import type { DoneMessage, DrawMessage, ToWorker } from "./protocol";
import type { TileRenderer } from "./renderer";
import { repaintOnRestore, repeatable } from "./repaint";
import { shadeRenderer, warm as warmShade } from "./shade";
import { streetScoreRenderer } from "./street-score";
import { subwayRenderer } from "./subway";
import { setShedDecks } from "./sweep";
import { setWorkerTheme } from "./theme";
import { treeDotsRenderer } from "./tree-dots";

// `self` types as a Window under the app's dom lib, and the webworker lib conflicts with it.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  postMessage(message: DoneMessage): void;
};

// Tiles still loading, and the subset Leaflet has since dropped.
const inFlight = new Set<number>();
const canceled = new Set<number>();
// Only this side can reach a transferred canvas, so only it can repaint a lost context.
const live = new Map<number, () => void>();

function forget(tileKey: number): void {
  live.get(tileKey)?.();
  live.delete(tileKey);
}

async function run<Params, Data>(
  renderer: TileRenderer<Params, Data>,
  params: Params,
  { tileKey, coords, ratio, canvas }: DrawMessage,
): Promise<void> {
  const data = await renderer.load(params, coords);
  if (canceled.has(tileKey)) {
    return;
  }
  const context = canvas.getContext("2d");
  if (context) {
    const paint = repeatable(context, ratio, (target) => {
      renderer.draw(target, data, coords, params, ratio);
    });
    // Registered before painting: the context may already be lost, and then the restore paints it.
    live.set(tileKey, repaintOnRestore(canvas, paint));
    paint();
  }
}

function rasterize(message: DrawMessage): Promise<void> {
  const { params } = message;
  switch (params.kind) {
    case "street-score":
      return run(streetScoreRenderer, params, message);
    case "commercial":
      return run(commercialRenderer, params, message);
    case "lines":
      return run(linesRenderer, params, message);
    case "industrial":
      return run(industrialRenderer, params, message);
    case "historic":
      return run(historicRenderer, params, message);
    case "subway":
      return run(subwayRenderer, params, message);
    case "poi":
      return run(poiRenderer, params, message);
    case "tree-dots":
      return run(treeDotsRenderer, params, message);
    case "canopy":
      return run(canopyRenderer, params, message);
    case "elevation":
      return run(elevationRenderer, params, message);
    case "shade":
      return run(shadeRenderer, params, message);
  }
}

function finish(tileKey: number, error?: string): void {
  inFlight.delete(tileKey);
  // Leaflet has already forgotten a dropped tile, so there is nothing to report.
  if (!canceled.delete(tileKey)) {
    scope.postMessage({ type: "done", tileKey, error });
  }
}

scope.onmessage = ({ data: message }) => {
  if (message.type === "init") {
    setBaseUrl(message.base);
  } else if (message.type === "shade-prefetch") {
    warmShade(message);
  } else if (message.type === "shed-decks") {
    setShedDecks(message.decks);
  } else if (message.type === "theme") {
    setWorkerTheme(message.theme);
  } else if (message.type === "cancel") {
    // Also releases a painted tile, whose watcher holds the canvas and the decoded data.
    forget(message.tileKey);
    if (inFlight.has(message.tileKey)) {
      canceled.add(message.tileKey);
    }
  } else {
    const { tileKey } = message;
    inFlight.add(tileKey);
    rasterize(message).then(
      () => {
        finish(tileKey);
      },
      (error: Error) => {
        finish(tileKey, error.message);
      },
    );
  }
};
