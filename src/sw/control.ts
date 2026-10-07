// A fetch made before the worker controls the page is never stored, so a first visit's kept files wait for it.

// Four times the install on a slow laptop; a link that needs longer for the 2 MB shell spends minutes on the graph.
export const CONTROL_WAIT_MS = 10_000;

interface WorkerLike {
  state: string;
  addEventListener(type: "statechange", listener: () => void): void;
}

interface RegistrationLike {
  active: WorkerLike | null;
  waiting: WorkerLike | null;
  installing: WorkerLike | null;
}

export interface ContainerLike {
  controller: unknown;
  addEventListener(type: "controllerchange", listener: () => void): void;
}

// Null where no worker is about to take this page: none supported, one in control, or a forced reload past it.
export function controlSettles(
  container: ContainerLike | undefined,
  registration: () => Promise<RegistrationLike>,
  waitMs: number,
): Promise<void> | null {
  if (!container || container.controller) {
    return null;
  }
  return new Promise((resolve) => {
    container.addEventListener("controllerchange", resolve);
    // A slow or stuck install must not hold up routing.
    setTimeout(resolve, waitMs);
    registration().then((registered) => {
      // An active worker that left this page alone was reloaded past, and a stub or failed install never claims.
      const worker =
        registered.active ?? registered.waiting ?? registered.installing;
      const over = (): boolean =>
        !worker || worker.state === "activated" || worker.state === "redundant";
      if (over()) {
        resolve();
      } else {
        worker?.addEventListener("statechange", () => {
          if (over()) {
            resolve();
          }
        });
      }
    }, resolve);
  });
}

let registered: Promise<ServiceWorkerRegistration> | null = null;

// Relative to the page, which sits at the site root; rejects on insecure origins or with workers disabled.
export function registerWorker(): Promise<ServiceWorkerRegistration> {
  registered ??= navigator.serviceWorker.register("sw.js");
  return registered;
}

// `undefined` is not asked yet; `null` is nothing left to wait for.
let pending: Promise<void> | null | undefined;

// Runs at once on every visit but the first, so those callers stay synchronous.
export function afterControl(run: () => void): void {
  if (pending === undefined) {
    const container =
      typeof navigator === "undefined"
        ? undefined
        : (navigator as Partial<Navigator>).serviceWorker;
    pending = controlSettles(container, registerWorker, CONTROL_WAIT_MS);
    void pending?.then(() => {
      pending = null;
    });
  }
  if (pending) {
    void pending.then(run);
  } else {
    run();
  }
}
