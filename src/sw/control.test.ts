import { afterEach, expect, test } from "bun:test";
import { type ContainerLike, controlSettles } from "./control";

class FakeWorker {
  private listener: (() => void) | null = null;
  constructor(public state: string) {}
  addEventListener(_type: "statechange", listener: () => void): void {
    this.listener = listener;
  }
  become(state: string): void {
    this.state = state;
    this.listener?.();
  }
}

class FakeContainer implements ContainerLike {
  controller: unknown = null;
  private listener: (() => void) | null = null;
  addEventListener(_type: "controllerchange", listener: () => void): void {
    this.listener = listener;
  }
  claim(): void {
    this.controller = {};
    this.listener?.();
  }
}

const registration = (
  slot: "active" | "waiting" | "installing",
  worker: FakeWorker,
) => {
  const registered = { active: null, waiting: null, installing: null };
  return () => Promise.resolve({ ...registered, [slot]: worker });
};

// Longer than any test, so only the case about the bound sees it pass.
const NEVER_MS = 60_000;

async function settled(wait: Promise<void> | null): Promise<boolean> {
  let done = wait === null;
  void wait?.then(() => {
    done = true;
  });
  await new Promise((resume) => setTimeout(resume, 5));
  return done;
}

test("nothing waits where no worker can take the page", () => {
  const installing = registration("installing", new FakeWorker("installing"));
  // No support, or an insecure origin such as plain http on a LAN host.
  expect(controlSettles(undefined, installing, NEVER_MS)).toBeNull();
  const controlled = new FakeContainer();
  controlled.controller = {};
  expect(controlSettles(controlled, installing, NEVER_MS)).toBeNull();
});

test("a first visit waits for the installing worker to claim the page", async () => {
  const container = new FakeContainer();
  const worker = new FakeWorker("installing");
  const wait = controlSettles(
    container,
    registration("installing", worker),
    NEVER_MS,
  );
  expect(await settled(wait)).toBe(false);
  worker.become("installed");
  worker.become("activating");
  expect(await settled(wait)).toBe(false);
  container.claim();
  expect(await settled(wait)).toBe(true);
});

test("a worker that will never claim the page ends the wait", async () => {
  const refused = () => Promise.reject(new Error("registration refused"));
  expect(
    await settled(controlSettles(new FakeContainer(), refused, NEVER_MS)),
  ).toBe(true);
  // A forced reload leaves the page uncontrolled beside an active worker.
  const active = registration("active", new FakeWorker("activated"));
  expect(
    await settled(controlSettles(new FakeContainer(), active, NEVER_MS)),
  ).toBe(true);
  for (const end of ["redundant", "activated"]) {
    const worker = new FakeWorker("installing");
    const wait = controlSettles(
      new FakeContainer(),
      registration("installing", worker),
      NEVER_MS,
    );
    expect(await settled(wait)).toBe(false);
    worker.become(end);
    expect(await settled(wait)).toBe(true);
  }
});

test("a stuck install holds routing up no longer than the bound", async () => {
  const wait = controlSettles(
    new FakeContainer(),
    registration("installing", new FakeWorker("installing")),
    1,
  );
  expect(await settled(wait)).toBe(true);
});

const browser = globalThis.navigator as unknown as { serviceWorker?: unknown };

afterEach(() => {
  delete browser.serviceWorker;
});

// The wait is held once per page load, so each case loads its own copy of the module.
async function pageLoad(
  name: string,
  container: FakeContainer,
  worker: FakeWorker,
): Promise<(run: () => void) => void> {
  browser.serviceWorker = Object.assign(container, {
    register: registration("installing", worker),
  });
  const loaded: typeof import("./control") = await import(
    `./control.ts?${name}`
  );
  return loaded.afterControl;
}

test("a later visit runs its callers at once", async () => {
  const container = new FakeContainer();
  container.controller = {};
  const afterControl = await pageLoad(
    "later",
    container,
    new FakeWorker("activated"),
  );
  let runs = 0;
  afterControl(() => {
    runs += 1;
  });
  expect(runs).toBe(1);
});

test("a first visit runs each caller once, when the worker takes the page", async () => {
  const container = new FakeContainer();
  const afterControl = await pageLoad(
    "first",
    container,
    new FakeWorker("installing"),
  );
  const ran: string[] = [];
  afterControl(() => ran.push("graph"));
  afterControl(() => ran.push("index"));
  await new Promise((resume) => setTimeout(resume, 5));
  expect(ran).toEqual([]);
  container.claim();
  // A second controllerchange, as a later update fires, runs nothing again.
  container.claim();
  await new Promise((resume) => setTimeout(resume, 5));
  expect(ran).toEqual(["graph", "index"]);
  // Asked after the wait is over, a caller is synchronous again.
  afterControl(() => ran.push("late"));
  expect(ran).toEqual(["graph", "index", "late"]);
});

test("a first visit whose install is discarded runs its callers anyway", async () => {
  const worker = new FakeWorker("installing");
  const afterControl = await pageLoad("discarded", new FakeContainer(), worker);
  let runs = 0;
  afterControl(() => {
    runs += 1;
  });
  await new Promise((resume) => setTimeout(resume, 5));
  expect(runs).toBe(0);
  worker.become("redundant");
  await new Promise((resume) => setTimeout(resume, 5));
  expect(runs).toBe(1);
});
