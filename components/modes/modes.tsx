"use client";

import { useCallback, useMemo, useReducer, useRef, useState } from "react";
import {
  type CardSummary,
  cardColors,
  cardLine,
  chipFactors,
  ferrySummaries,
  rideSummaries,
  visibleChips,
} from "../../src/modes/cards";
import {
  DEFAULT_MODE,
  DEFAULT_TOGGLES,
  effectiveWeights,
  graphFactors,
  type Mode,
  type ModeId,
  modeForCity,
  type Toggles,
} from "../../src/modes/modes";
import { NO_PLAN, planClock, planReducer } from "../../src/modes/plan-state";
import {
  clampSelection,
  type EndpointsKey,
  endpointsMoved,
} from "../../src/modes/selection";
import type { OverlayId } from "../../src/overlays/registry";
import { getResolvedDate } from "../../src/route-time/store";
import type { PlannedRoute } from "../../src/routing/alternatives";
import type { RouteWeights } from "../../src/routing/cost";
import { routerClient } from "../../src/routing/router-client";
import type { RouteResult } from "../../src/routing/search";
import {
  settings as storedSettings,
  updateSettings,
} from "../../src/settings/store";
import { decodeModes, type PlaceUrlState } from "../../src/url-state";
import GoogleMapsButton from "../google-maps-button";
import MapShell, {
  type RoutingContext,
  type SolveReply,
  type SolveRequest,
} from "../map-shell";
import type { RouteLine } from "../route-layer";
import { ModesControls, ModesPanels } from "./deck";
import ModeLayers from "./layer-list";
import type { CardView } from "./route-cards";

// One shared array before a plan lands, so the memos keep identity.
const NO_ROUTES: readonly PlannedRoute[] = [];

function summaryOf(result: RouteResult): CardSummary {
  return {
    travelSeconds: result.travelSeconds,
    walkMeters: result.walkMeters,
    ferries: ferrySummaries(result.ferries),
    rides: rideSummaries(result.rides),
  };
}

export default function Modes() {
  const [modeId, setModeId] = useState<ModeId>(DEFAULT_MODE.id);
  const [toggles, setToggles] = useState<Toggles>(DEFAULT_TOGGLES);
  // By index; null is browsing them all.
  const [alt, setAlt] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [{ landed, pending, capturedAt }, dispatch] = useReducer(
    planReducer,
    NO_PLAN,
  );
  // Read when the link is, not at first render, since the server render has no settings.
  const [hiddenLayers, setHiddenLayers] = useState<
    Partial<Record<ModeId, readonly OverlayId[]>>
  >({});
  // Only the close takes it away, so emptying a field asks again.
  const [directionsOpen, setDirectionsOpen] = useState<boolean>(false);
  const planId = useRef<number>(0);
  // The only thing that moves the departure time: the routes answer the minute they were asked for.
  const recapture = useCallback(() => {
    dispatch({
      kind: "captured",
      clock: planClock(getResolvedDate().getTime()),
    });
  }, []);

  // Asked at the shell rather than mirrored into state that would trail a city switch by a render.
  const weights = useCallback(
    ({ city, available }: RoutingContext): RouteWeights =>
      effectiveWeights(modeForCity(city, modeId), toggles, available),
    [modeId, toggles],
  );
  // Each switch replaces the set outright, so the genus overlay's exclusivity holds by construction.
  const activeOverlays = useCallback(
    ({ city }: RoutingContext): ReadonlySet<OverlayId> => {
      const mode = modeForCity(city, modeId);
      const hidden = hiddenLayers[mode.id] ?? [];
      return new Set<OverlayId>(
        mode.overlays.filter((id) => !hidden.includes(id)),
      );
    },
    [modeId, hiddenLayers],
  );
  const accent = useCallback(
    ({ city }: RoutingContext): string => modeForCity(city, modeId).color,
    [modeId],
  );

  // Keyed on the resolved mode, not the stored id, which may name a mode this city doesn't show.
  const handleToggleLayer = useCallback(
    (mode: Mode, id: OverlayId) => {
      const hidden = hiddenLayers[mode.id] ?? [];
      const next = hidden.includes(id)
        ? hidden.filter((entry) => entry !== id)
        : [...hidden, id];
      const layers = { ...hiddenLayers, [mode.id]: next };
      setHiddenLayers(layers);
      updateSettings({ modeLayers: layers });
    },
    [hiddenLayers],
  );

  const legend = useCallback(
    ({ city }: RoutingContext) => {
      const mode = modeForCity(city, modeId);
      return (
        <ModeLayers
          city={city}
          overlays={mode.overlays}
          hidden={new Set(hiddenLayers[mode.id] ?? [])}
          onToggle={(id) => handleToggleLayer(mode, id)}
        />
      );
    },
    [modeId, hiddenLayers, handleToggleLayer],
  );

  // The cards wait for the whole sweep, since their colors and bold chips depend on the set.
  const solve = useCallback(
    async (request: SolveRequest): Promise<SolveReply | null> => {
      const id = ++planId.current;
      dispatch({ kind: "started", id, graph: request.graph });
      const started = performance.now();
      let plan: Awaited<ReturnType<ReturnType<typeof routerClient>["plan"]>>;
      try {
        plan = await routerClient().plan(
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
      if (plan === null) {
        // A newer plan overtook this one and owns the flag now.
        dispatch({ kind: "failed", id });
        return null;
      }
      console.info(
        `plan: ${plan.routes.length} routes from ${plan.searches} searches in ${Math.round(performance.now() - started)} ms`,
      );
      dispatch({
        kind: "landed",
        landed: {
          id,
          graph: request.graph,
          mode: modeForCity(request.city, modeId),
          available: graphFactors(request.graph),
          plan,
        },
      });
      // Only meaningful while this plan has a card at that index.
      setAlt((current) => clampSelection(current, plan.routes.length));
      return { result: plan.routes[0]?.result ?? null, changed: true };
    },
    [modeId],
  );

  const routes = landed?.plan.routes ?? NO_ROUTES;
  // Cards run most scenic first (`CARD_ORDER`), so the first is the route already on the map.
  const highlighted = hovered ?? alt ?? 0;

  const colors = useMemo<string[]>(
    () => (landed ? cardColors(landed.mode, routes) : []),
    [routes, landed],
  );

  const cards = useMemo<CardView[]>(() => {
    if (!landed) {
      return [];
    }
    const chips = visibleChips(
      chipFactors(landed.mode, landed.available),
      routes.map((route) => route.result.factors),
    );
    return routes.map((route, index) => ({
      summary: summaryOf(route.result),
      color: colors[index],
      chips: chips[index],
    }));
  }, [routes, colors, landed]);

  const planning = pending !== null;

  const lines: RouteLine[] = useMemo(() => {
    const all = routes.map((route, index) => ({
      result: route.result,
      color: colors[index],
      // A chosen route is the only one drawn, and numbering a set of one says nothing.
      label: alt === null ? String(index + 1) : "",
      selected: index === highlighted,
      dimmed: planning,
    }));
    return alt === null ? all : all.filter((_, index) => index === alt);
  }, [routes, colors, highlighted, alt, planning]);

  const handleSelectLine = useCallback((index: number) => {
    setAlt((current) => current ?? index);
  }, []);

  // The max-scenic candidate stands in while the first sweep runs.
  const chosen = useMemo(() => {
    if (landed) {
      const result = routes[alt ?? 0]?.result;
      return result ? { result, graph: landed.graph } : null;
    } else if (pending?.preview) {
      return { result: pending.preview, graph: pending.graph };
    } else {
      return null;
    }
  }, [landed, routes, alt, pending]);

  const handleMode = useCallback(
    (id: ModeId) => {
      setModeId(id);
      setAlt(null);
      recapture();
      updateSettings({ mode: id });
    },
    [recapture],
  );

  const handleToggles = useCallback(
    (next: Toggles) => {
      setToggles(next);
      setAlt(null);
      recapture();
      updateSettings({ toggles: next });
    },
    [recapture],
  );

  // Going back replans, so the reader chooses from routes planned now, not when this trip began.
  const handleBack = useCallback(() => {
    setAlt(null);
    recapture();
  }, [recapture]);

  // Also the shell's `onRoutingReset`; either way it has already dropped the endpoints and the route.
  const handleClose = useCallback(() => {
    setDirectionsOpen(false);
    setAlt(null);
    setHovered(null);
    dispatch({ kind: "cleared" });
  }, []);

  // A link's own alt survives its endpoints arriving; a moved endpoint clears it.
  const endpointsRef = useRef<EndpointsKey | null>(null);
  const handleEndpoints = useCallback(
    (key: EndpointsKey | null): boolean => {
      const moved = endpointsMoved(endpointsRef.current, key);
      if (moved) {
        setAlt(null);
      }
      endpointsRef.current = key;
      if (key === null) {
        dispatch({ kind: "cleared" });
      } else {
        setDirectionsOpen(true);
        recapture();
      }
      return moved;
    },
    [recapture],
  );

  // A key in the link wins; a missing one keeps what the reader last chose.
  const handleLink = useCallback((params: URLSearchParams): PlaceUrlState => {
    const {
      mode: storedMode,
      toggles: storedToggles,
      modeLayers,
    } = storedSettings();
    const state = decodeModes(params, {
      start: null,
      dest: null,
      pin: null,
      customHour: null,
      customDay: null,
      mode: storedMode,
      alt: null,
      toggles: storedToggles,
    });
    setModeId(state.mode);
    setToggles(state.toggles);
    setAlt(state.alt);
    setHiddenLayers(modeLayers);
    return state;
  }, []);

  return (
    <MapShell
      weights={weights}
      activeOverlays={activeOverlays}
      accent={accent}
      onLink={handleLink}
      clock={capturedAt}
      solve={solve}
      chosen={chosen}
      lines={lines}
      onSelectLine={handleSelectLine}
      onHoverLine={setHovered}
      onRoutingReset={handleClose}
      legend={legend}
      legends="top-left-on-phone"
      ownSearch={false}
      alwaysRouting
      tapSearch={!directionsOpen}
      liveDrag={false}
      deck={(shell) => {
        // Replanning leaves no chosen route to peek at, so the shrunk card comes back.
        const expand = (act: () => boolean): void => {
          if (act() && shell.minimized) {
            shell.onToggleMinimize();
          }
        };
        const state = {
          modeId,
          toggles,
          alt,
          cards,
          // A dragged pin holds the plan like a running sweep; the sweep starts on the drop.
          planning: planning || shell.dragging,
          planningLine:
            pending?.preview && landed === null
              ? cardLine(summaryOf(pending.preview))
              : null,
          directionsOpen,
          onMode: (id: ModeId) =>
            expand(() => {
              handleMode(id);
              return true;
            }),
          onToggles: (next: Toggles) =>
            expand(() => {
              handleToggles(next);
              return true;
            }),
          onSelect: setAlt,
          onHover: setHovered,
          onBack: handleBack,
          onClose: handleClose,
          onEndpoints: (key: EndpointsKey | null) =>
            expand(() => handleEndpoints(key)),
        };
        return {
          controls: <ModesControls shell={shell} state={state} />,
          panels: (
            <ModesPanels
              shell={shell}
              state={state}
              exportAction={
                chosen && shell.exportOrigin && shell.dest ? (
                  <GoogleMapsButton
                    plan={shell.waypointPlan}
                    start={shell.exportOrigin}
                    dest={shell.dest}
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-full transition hover:bg-slate-100 disabled:pointer-events-none disabled:opacity-40 dark:hover:bg-slate-700"
                  />
                ) : null
              }
            />
          ),
        };
      }}
    />
  );
}
