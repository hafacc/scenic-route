import { setBaseUrl } from "./base-url";
import { canopyRenderer } from "./canopy";
import { commercialRenderer } from "./commercial";
import { elevationRenderer } from "./elevation";
import { genusRenderer } from "./genus";
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
import { TileQueue } from "./tile-queue";
import { treeDotsRenderer } from "./tree-dots";

// `self` types as a Window under the app's dom lib, and the webworker lib conflicts with it.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  postMessage(message: DoneMessage): void;
};

// Only this side can reach a transferred canvas, so only it can repaint a lost context.
const live = new Map<number, () => void>();

async function run<Params, Data>(
  renderer: TileRenderer<Params, Data>,
  params: Params,
  { tileKey, coords, ratio, canvas }: DrawMessage,
  current: () => boolean,
): Promise<void> {
  const data = await renderer.load(params, coords);
  if (!current()) {
    return;
  }
  const context = canvas.getContext("2d");
  if (context) {
    const paint = (loaded: Data): void => {
      repeatable(context, ratio, (target) => {
        renderer.draw(target, loaded, coords, params, ratio);
      })();
    };
    // A restore reloads from the renderers' caches, so a painted tile doesn't pin its decoded sources.
    const restore = (): void => {
      renderer.load(params, coords).then(
        (loaded) => {
          // A repaint that landed meanwhile owns the canvas now.
          if (current()) {
            paint(loaded);
          }
        },
        () => undefined,
      );
    };
    // Registered before painting: the context may already be lost, and then the restore paints it.
    live.get(tileKey)?.();
    live.set(tileKey, repaintOnRestore(canvas, restore));
    paint(data);
  }
}

function rasterize(
  message: DrawMessage,
  current: () => boolean,
): Promise<void> {
  const { params } = message;
  switch (params.kind) {
    case "street-score":
      return run(streetScoreRenderer, params, message, current);
    case "commercial":
      return run(commercialRenderer, params, message, current);
    case "lines":
      return run(linesRenderer, params, message, current);
    case "industrial":
      return run(industrialRenderer, params, message, current);
    case "historic":
      return run(historicRenderer, params, message, current);
    case "subway":
      return run(subwayRenderer, params, message, current);
    case "poi":
      return run(poiRenderer, params, message, current);
    case "tree-dots":
      return run(treeDotsRenderer, params, message, current);
    case "canopy":
      return run(canopyRenderer, params, message, current);
    case "genus":
      return run(genusRenderer, params, message, current);
    case "elevation":
      return run(elevationRenderer, params, message, current);
    case "shade":
      return run(shadeRenderer, params, message, current);
  }
}

const queue = new TileQueue(rasterize, (done) => {
  scope.postMessage(done);
});

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
    live.get(message.tileKey)?.();
    live.delete(message.tileKey);
    queue.cancel(message.tileKey);
  } else if (message.type === "repaint") {
    queue.repaint(message.tileKeys, message.params);
  } else {
    queue.draw(message);
  }
};
