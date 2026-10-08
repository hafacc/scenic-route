<script lang="ts">
import {
  type CardSummary,
  cardColors,
  cardLine,
  chipFactors,
  ferrySummaries,
  rideSummaries,
  visibleChips,
} from "../../src/lenses/cards";
import {
  DEFAULT_LENS,
  DEFAULT_TOGGLES,
  effectiveWeights,
  graphFactors,
  type Lens,
  type LensId,
  lensForCity,
  type Toggles,
} from "../../src/lenses/lenses";
import {
  NO_PLAN,
  type PlanAction,
  type PlanState,
  planClock,
  planReducer,
} from "../../src/lenses/plan-state";
import {
  clampSelection,
  type EndpointsKey,
  endpointsMoved,
} from "../../src/lenses/selection";
import type { OverlayId } from "../../src/overlays/registry";
import { getResolvedDate } from "../../src/route-time/store";
import type { PlannedRoute } from "../../src/routing/alternatives";
import type { RouteWeights } from "../../src/routing/cost";
import type { RoutingGraph } from "../../src/routing/graph";
import { routerClient } from "../../src/routing/router-client";
import type { RouteResult } from "../../src/routing/search";
import {
  settings as storedSettings,
  updateSettings,
} from "../../src/settings/store";
import { decodeLenses, type PlaceUrlState } from "../../src/url-state";
import GoogleMapsButton from "../google-maps-button.svelte";
import MapShell from "../map-shell.svelte";
import type { RouteLine } from "../map-types";
import type {
  RoutingContext,
  ShellDeck,
  SolveReply,
  SolveRequest,
} from "../shell-types";
import LensLayers from "./layer-list.svelte";
import LensesControls from "./lenses-controls.svelte";
import LensesPanels from "./lenses-panels.svelte";
import type { LensesState } from "./lenses-state";
import type { CardView } from "./route-cards";

// One shared array before a plan lands, so what derives from it keeps its identity.
const NO_ROUTES: readonly PlannedRoute[] = [];

const EXPORT_BUTTON =
  "grid h-8 w-8 shrink-0 place-items-center rounded-full transition hover:bg-slate-100 disabled:pointer-events-none disabled:opacity-40 dark:hover:bg-slate-700";

function summaryOf(result: RouteResult): CardSummary {
  return {
    travelSeconds: result.travelSeconds,
    walkMeters: result.walkMeters,
    ferries: ferrySummaries(result.ferries),
    rides: rideSummaries(result.rides),
  };
}

let lensId = $state.raw<LensId>(DEFAULT_LENS.id);
let toggles = $state.raw<Toggles>(DEFAULT_TOGGLES);
// By index; null is browsing them all.
let alt = $state.raw<number | null>(null);
let hovered = $state.raw<number | null>(null);
let plan = $state.raw<PlanState>(NO_PLAN);
function dispatch(action: PlanAction): void {
  plan = planReducer(plan, action);
}
const landed = $derived(plan.landed);
const pending = $derived(plan.pending);
const capturedAt = $derived(plan.capturedAt);
// Read when the link is, not at first render, since the server render has no settings.
let hiddenLayers = $state.raw<Partial<Record<LensId, readonly OverlayId[]>>>(
  {},
);
// Only the close takes it away, so emptying a field asks again.
let directionsOpen = $state.raw<boolean>(false);
let planId = 0;
// The only thing that moves the departure time: the routes answer the minute they were asked for.
function recapture(): void {
  dispatch({
    kind: "captured",
    clock: planClock(getResolvedDate().getTime()),
  });
}

// Called inside the shell's own deriveds, which is what follows the lens, the switches and the city.
function weights({ city, available }: RoutingContext): RouteWeights {
  return effectiveWeights(lensForCity(city, lensId), toggles, available);
}
// Each switch replaces the set outright, so the genus overlay's exclusivity holds by construction.
function activeOverlays({ city }: RoutingContext): ReadonlySet<OverlayId> {
  const lens = lensForCity(city, lensId);
  const hidden = hiddenLayers[lens.id] ?? [];
  return new Set<OverlayId>(
    lens.overlays.filter((overlay) => !hidden.includes(overlay)),
  );
}
function accent({ city }: RoutingContext): string {
  return lensForCity(city, lensId).color;
}

// Keyed on the resolved lens, not the stored id, which may name a lens this city doesn't show.
function handleToggleLayer(lens: Lens, id: OverlayId): void {
  const hidden = hiddenLayers[lens.id] ?? [];
  const next = hidden.includes(id)
    ? hidden.filter((entry) => entry !== id)
    : [...hidden, id];
  const layers = { ...hiddenLayers, [lens.id]: next };
  hiddenLayers = layers;
  updateSettings({ lensLayers: layers });
}

function hiddenIn(lens: Lens): ReadonlySet<OverlayId> {
  return new Set(hiddenLayers[lens.id] ?? []);
}

// The cards wait for the whole sweep, since their colors and bold chips depend on the set.
async function solve(request: SolveRequest): Promise<SolveReply | null> {
  // Held from the ask, since the reader may switch before the sweep lands.
  const asked = lensId;
  const id = ++planId;
  dispatch({ kind: "started", id, graph: request.graph });
  const started = performance.now();
  let swept: Awaited<ReturnType<ReturnType<typeof routerClient>["plan"]>>;
  try {
    swept = await routerClient().plan(
      {
        cityId: request.city.id,
        clock: request.clock,
        start: request.start,
        dest: request.dest,
        weights: request.weights,
      },
      (result) => dispatch({ kind: "preview", id, result }),
    );
  } catch (error) {
    dispatch({ kind: "failed", id });
    throw error;
  }
  if (swept === null) {
    // A newer plan overtook this one and owns the flag now.
    dispatch({ kind: "failed", id });
    return null;
  }
  const count = swept.routes.length;
  console.info(
    `plan: ${count} routes from ${swept.searches} searches in ${Math.round(performance.now() - started)} ms`,
  );
  dispatch({
    kind: "landed",
    landed: {
      id,
      graph: request.graph,
      lens: lensForCity(request.city, asked),
      available: graphFactors(request.graph),
      plan: swept,
    },
  });
  // Only meaningful while this plan has a card at that index.
  alt = clampSelection(alt, count);
  return { result: swept.routes[0]?.result ?? null, changed: true };
}

const routes = $derived(landed?.plan.routes ?? NO_ROUTES);
// Cards run most scenic first (`CARD_ORDER`), so the first is the route already on the map.
const highlighted = $derived(hovered ?? alt ?? 0);

const colors = $derived(landed ? cardColors(landed.lens, routes) : []);

const cards = $derived.by((): CardView[] => {
  if (!landed) {
    return [];
  }
  const chips = visibleChips(
    chipFactors(landed.lens, landed.available),
    routes.map((route) => route.result.factors),
  );
  return routes.map((route, index) => ({
    summary: summaryOf(route.result),
    color: colors[index],
    chips: chips[index],
  }));
});

const planning = $derived(pending !== null);

const lines = $derived.by((): RouteLine[] => {
  const all = routes.map((route, index) => ({
    result: route.result,
    color: colors[index],
    // A chosen route is the only one drawn, and numbering a set of one says nothing.
    label: alt === null ? String(index + 1) : "",
    selected: index === highlighted,
    dimmed: planning,
  }));
  return alt === null ? all : all.filter((_, index) => index === alt);
});

function handleSelectLine(index: number): void {
  alt ??= index;
}

function handleSelect(index: number): void {
  alt = index;
}

function handleHover(index: number | null): void {
  hovered = index;
}

// The max-scenic candidate stands in while the first sweep runs.
const chosen = $derived.by(
  (): { result: RouteResult; graph: RoutingGraph } | null => {
    if (landed) {
      const result = routes[alt ?? 0]?.result;
      return result ? { result, graph: landed.graph } : null;
    } else if (pending?.preview) {
      return { result: pending.preview, graph: pending.graph };
    } else {
      return null;
    }
  },
);

function handleLens(id: LensId): void {
  lensId = id;
  alt = null;
  recapture();
  updateSettings({ lens: id });
}

function handleToggles(next: Toggles): void {
  toggles = next;
  alt = null;
  recapture();
  updateSettings({ toggles: next });
}

// Going back replans, so the reader chooses from routes planned now, not when this trip began.
function handleBack(): void {
  alt = null;
  recapture();
}

// Also the shell's `onRoutingReset`; either way it has already dropped the endpoints and the route.
function handleClose(): void {
  directionsOpen = false;
  alt = null;
  hovered = null;
  dispatch({ kind: "cleared" });
}

// A link's own alt survives its endpoints arriving; a moved endpoint clears it.
let lastEndpoints: EndpointsKey | null = null;
function handleEndpoints(key: EndpointsKey | null): boolean {
  const moved = endpointsMoved(lastEndpoints, key);
  if (moved) {
    alt = null;
  }
  lastEndpoints = key;
  if (key === null) {
    dispatch({ kind: "cleared" });
  } else {
    directionsOpen = true;
    recapture();
  }
  return moved;
}

// A key in the link wins; a missing one keeps what the reader last chose.
function handleLink(params: URLSearchParams): PlaceUrlState {
  const {
    lens: storedLens,
    toggles: storedToggles,
    lensLayers,
  } = storedSettings();
  const linked = decodeLenses(params, {
    start: null,
    dest: null,
    pin: null,
    customHour: null,
    customDay: null,
    lens: storedLens,
    alt: null,
    toggles: storedToggles,
  });
  lensId = linked.lens;
  toggles = linked.toggles;
  alt = linked.alt;
  hiddenLayers = lensLayers;
  return linked;
}

// Getters, so both slots follow the fields.
const deck: LensesState = {
  get lensId() {
    return lensId;
  },
  get toggles() {
    return toggles;
  },
  get alt() {
    return alt;
  },
  get cards() {
    return cards;
  },
  get planning() {
    return planning;
  },
  get planningLine() {
    return pending?.preview && landed === null
      ? cardLine(summaryOf(pending.preview))
      : null;
  },
  get directionsOpen() {
    return directionsOpen;
  },
  onLens: handleLens,
  onToggles: handleToggles,
  onSelect: handleSelect,
  onHover: handleHover,
  onBack: handleBack,
  onClose: handleClose,
  onEndpoints: handleEndpoints,
};

function exportable(shell: ShellDeck): boolean {
  return chosen !== null && shell.exportOrigin !== null && shell.dest !== null;
}
</script>

{#snippet controls(
  shell: ShellDeck,
)}
  <LensesControls {shell} {deck} />
{/snippet}

{#snippet panels(
  shell: ShellDeck,
)}
  {#snippet exportButton()}
    <!-- Narrows the two for the button; the slot is null whenever either is. -->
    {#if shell.exportOrigin && shell.dest}
      <GoogleMapsButton
        plan={shell.waypointPlan}
        start={shell.exportOrigin}
        dest={shell.dest}
        class={EXPORT_BUTTON}
      />
    {/if}
  {/snippet}
  <LensesPanels
    {shell}
    {deck}
    exportAction={exportable(shell) ? exportButton : null}
  />
{/snippet}

{#snippet legend(
  context: RoutingContext,
)}
  <LensLayers
    city={context.city}
    overlays={lensForCity(context.city, lensId).overlays}
    hidden={hiddenIn(lensForCity(context.city, lensId))}
    onToggle={(id) => handleToggleLayer(lensForCity(context.city, lensId), id)}
  />
{/snippet}

<MapShell
  {weights}
  {activeOverlays}
  {accent}
  onLink={handleLink}
  clock={capturedAt}
  {solve}
  {chosen}
  {lines}
  onSelectLine={handleSelectLine}
  onHoverLine={handleHover}
  onRoutingReset={handleClose}
  {legend}
  legends="top-left-on-phone"
  ownSearch={false}
  alwaysRouting
  tapSearch={!directionsOpen}
  liveDrag={false}
  {controls}
  {panels}
/>
