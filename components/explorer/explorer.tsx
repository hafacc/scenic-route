"use client";

import { useCallback, useMemo, useState } from "react";
import {
  applyExclusivity,
  isOverlayId,
  OVERLAYS,
  type OverlayId,
} from "../../src/overlays/registry";
import {
  DEFAULT_ART_WEIGHT,
  DEFAULT_COMMERCIAL_WEIGHT,
  DEFAULT_FERRY_WEIGHT,
  DEFAULT_HIGHWAY_WEIGHT,
  DEFAULT_HILL_WEIGHT,
  DEFAULT_HISTORIC_WEIGHT,
  DEFAULT_INDUSTRIAL_WEIGHT,
  DEFAULT_LANDMARK_WEIGHT,
  DEFAULT_SHADE_WEIGHT,
  DEFAULT_SHELTER_WEIGHT,
  DEFAULT_TREE_WEIGHT,
  MAX_FERRY_WEIGHT,
  MAX_HIGHWAY_WEIGHT,
  MAX_HILL_WEIGHT,
  MAX_INDUSTRIAL_WEIGHT,
  MAX_SHADE_WEIGHT,
  MAX_SHELTER_WEIGHT,
  MAX_TREE_WEIGHT,
  type RouteWeights,
} from "../../src/routing/cost";
import type { FactorKey, GateKey } from "../../src/routing/factors";
import {
  settings as storedSettings,
  updateSettings,
} from "../../src/settings/store";
import {
  decodeRoute,
  decodeView,
  type PlaceUrlState,
  type RouteUrlState,
} from "../../src/url-state";
import MapShell from "../map-shell";
import { ExplorerControls, ExplorerPanels } from "./deck";

const OVERLAY_KEY = "scenic-route:overlay";

// The weights the settings document holds, each falling back to its default. These are what a URL key
// overrides and what a missing one leaves in place.
function storedWeights(): RouteWeights {
  const { weights, allowFerries, allowSheds, allowCrossings } =
    storedSettings();
  const read = (key: FactorKey, fallback: number, min: number, max: number) => {
    const stored = weights[key];
    return stored === undefined
      ? fallback
      : Math.min(max, Math.max(min, stored));
  };
  return {
    tree: read("tree", DEFAULT_TREE_WEIGHT, 0, MAX_TREE_WEIGHT),
    ferry: read("ferry", DEFAULT_FERRY_WEIGHT, 0, MAX_FERRY_WEIGHT),
    landmark: read("landmark", DEFAULT_LANDMARK_WEIGHT, 0, 1),
    art: read("art", DEFAULT_ART_WEIGHT, 0, 1),
    highway: read("highway", DEFAULT_HIGHWAY_WEIGHT, 0, MAX_HIGHWAY_WEIGHT),
    hill: read("hill", DEFAULT_HILL_WEIGHT, 0, MAX_HILL_WEIGHT),
    commercial: read("commercial", DEFAULT_COMMERCIAL_WEIGHT, 0, 1),
    industrial: read(
      "industrial",
      DEFAULT_INDUSTRIAL_WEIGHT,
      0,
      MAX_INDUSTRIAL_WEIGHT,
    ),
    historic: read("historic", DEFAULT_HISTORIC_WEIGHT, 0, 1),
    shade: read(
      "shade",
      DEFAULT_SHADE_WEIGHT,
      -MAX_SHADE_WEIGHT,
      MAX_SHADE_WEIGHT,
    ),
    shelter: read("shelter", DEFAULT_SHELTER_WEIGHT, 0, MAX_SHELTER_WEIGHT),
    allowFerries,
    allowSheds,
    allowCrossings,
  };
}

// The panel's slider and the settings page's move the same value, so both persist through here. A
// weight nobody has moved stays out of the document and keeps its built-in default.
function persistWeight(key: FactorKey, weight: number): void {
  updateSettings({ weights: { ...storedSettings().weights, [key]: weight } });
}

// The persisted overlay ids, or null when nothing was ever stored (which keeps the canopy default).
// An empty stored string is a deliberate "all off".
function storedOverlays(): string[] | null {
  const stored = window.localStorage.getItem(OVERLAY_KEY);
  return stored === null ? null : stored.split(",");
}

export default function Explorer() {
  // The overlays drawn over the basemap, a freely-combinable set (tree genus is the one exception —
  // it goes solo). The canopy cover is the only content a signed-out visitor has, so it starts on.
  // Hydrated from the URL hash or localStorage below; an empty set hides every overlay.
  const [activeOverlays, setActiveOverlays] = useState<ReadonlySet<OverlayId>>(
    () => new Set<OverlayId>(["canopy"]),
  );
  const [treeWeight, setTreeWeight] = useState<number>(DEFAULT_TREE_WEIGHT);
  // Ferry preference and gate, driven by the route panel's slider and toggle. Both restore from
  // localStorage below so a reload keeps the setting.
  const [ferryWeight, setFerryWeight] = useState<number>(DEFAULT_FERRY_WEIGHT);
  const [allowFerries, setAllowFerries] = useState<boolean>(true);
  // The other scenic factors: landmark and public-art discounts and the highway/rail penalty. Held
  // here at their defaults (their sliders land in a later pass), restored from localStorage below.
  const [landmarkWeight, setLandmarkWeight] = useState<number>(
    DEFAULT_LANDMARK_WEIGHT,
  );
  const [artWeight, setArtWeight] = useState<number>(DEFAULT_ART_WEIGHT);
  const [highwayWeight, setHighwayWeight] = useState<number>(
    DEFAULT_HIGHWAY_WEIGHT,
  );
  const [hillWeight, setHillWeight] = useState<number>(DEFAULT_HILL_WEIGHT);
  const [commercialWeight, setCommercialWeight] = useState<number>(
    DEFAULT_COMMERCIAL_WEIGHT,
  );
  const [industrialWeight, setIndustrialWeight] = useState<number>(
    DEFAULT_INDUSTRIAL_WEIGHT,
  );
  const [historicWeight, setHistoricWeight] = useState<number>(
    DEFAULT_HISTORIC_WEIGHT,
  );
  // −1 = prefer shade, +1 = prefer sun, 0 = off; the shell follows the clock while this is set.
  const [shadeWeight, setShadeWeight] = useState<number>(DEFAULT_SHADE_WEIGHT);
  // Rain shelter (decks plus canopy) and the scaffolding gate. Both read the same per-edge shed
  // coverage, which moves only with the picked day, so a clock tick re-aims its sun.
  const [shelterWeight, setShelterWeight] = useState<number>(
    DEFAULT_SHELTER_WEIGHT,
  );
  const [allowSheds, setAllowSheds] = useState<boolean>(true);
  const [allowCrossings, setAllowCrossings] = useState<boolean>(false);

  // The cost context every search runs against, and what the URL and the share link carry.
  const weights: RouteWeights = useMemo(
    () => ({
      tree: treeWeight,
      ferry: ferryWeight,
      landmark: landmarkWeight,
      art: artWeight,
      highway: highwayWeight,
      hill: hillWeight,
      commercial: commercialWeight,
      industrial: industrialWeight,
      historic: historicWeight,
      shade: shadeWeight,
      shelter: shelterWeight,
      allowFerries,
      allowSheds,
      allowCrossings,
    }),
    [
      allowCrossings,
      treeWeight,
      ferryWeight,
      landmarkWeight,
      artWeight,
      highwayWeight,
      hillWeight,
      commercialWeight,
      industrialWeight,
      historicWeight,
      shadeWeight,
      shelterWeight,
      allowFerries,
      allowSheds,
    ],
  );

  // Toggle one overlay. Tree genus is exclusive: turning it on clears the rest, and turning on any
  // normal layer clears it — so the dense per-genus recolouring never fights the other overlays.
  const handleToggleOverlay = useCallback((id: OverlayId) => {
    setActiveOverlays((current) => {
      const next = new Set(current);
      const isExclusive = (candidate: OverlayId): boolean =>
        OVERLAYS.find((overlay) => overlay.id === candidate)?.exclusive ??
        false;
      if (next.has(id)) {
        next.delete(id);
      } else if (isExclusive(id)) {
        next.clear();
        next.add(id);
      } else {
        next.add(id);
        for (const other of next) {
          if (isExclusive(other)) {
            next.delete(other);
          }
        }
      }
      window.localStorage.setItem(OVERLAY_KEY, [...next].join(","));
      return next;
    });
  }, []);

  const handleTreeWeight = useCallback((weight: number) => {
    setTreeWeight(weight);
    persistWeight("tree", weight);
  }, []);

  const handleFerryWeight = useCallback((weight: number) => {
    setFerryWeight(weight);
    persistWeight("ferry", weight);
  }, []);

  const handleLandmarkWeight = useCallback((weight: number) => {
    setLandmarkWeight(weight);
    persistWeight("landmark", weight);
  }, []);

  const handleArtWeight = useCallback((weight: number) => {
    setArtWeight(weight);
    persistWeight("art", weight);
  }, []);

  const handleHillWeight = useCallback((weight: number) => {
    setHillWeight(weight);
    persistWeight("hill", weight);
  }, []);

  const handleHighwayWeight = useCallback((weight: number) => {
    setHighwayWeight(weight);
    persistWeight("highway", weight);
  }, []);

  const handleCommercialWeight = useCallback((weight: number) => {
    setCommercialWeight(weight);
    persistWeight("commercial", weight);
  }, []);

  const handleIndustrialWeight = useCallback((weight: number) => {
    setIndustrialWeight(weight);
    persistWeight("industrial", weight);
  }, []);

  const handleHistoricWeight = useCallback((weight: number) => {
    setHistoricWeight(weight);
    persistWeight("historic", weight);
  }, []);

  const handleShadeWeight = useCallback((weight: number) => {
    setShadeWeight(weight);
    persistWeight("shade", weight);
  }, []);

  const handleShelterWeight = useCallback((weight: number) => {
    setShelterWeight(weight);
    persistWeight("shelter", weight);
  }, []);

  // The three switches, by key rather than a callback each: they are a table now (src/routing/
  // factors.tsx), and a callback each would be a fourth place to add a line every time one is added.
  const handleGate = useCallback((key: GateKey, on: boolean) => {
    const setters: Record<GateKey, (on: boolean) => void> = {
      allowFerries: setAllowFerries,
      allowSheds: setAllowSheds,
      allowCrossings: setAllowCrossings,
    };
    setters[key](on);
    updateSettings({ [key]: on });
  }, []);

  // The settings page edits the same weights the panel does, and sends a key and a value rather than
  // carrying a callback per factor.
  const handleWeight = useCallback(
    (key: FactorKey, weight: number) => {
      const setters: Record<FactorKey, (weight: number) => void> = {
        tree: handleTreeWeight,
        ferry: handleFerryWeight,
        landmark: handleLandmarkWeight,
        art: handleArtWeight,
        highway: handleHighwayWeight,
        hill: handleHillWeight,
        commercial: handleCommercialWeight,
        industrial: handleIndustrialWeight,
        historic: handleHistoricWeight,
        shade: handleShadeWeight,
        shelter: handleShelterWeight,
      };
      setters[key](weight);
    },
    [
      handleTreeWeight,
      handleFerryWeight,
      handleLandmarkWeight,
      handleArtWeight,
      handleHighwayWeight,
      handleHillWeight,
      handleCommercialWeight,
      handleIndustrialWeight,
      handleHistoricWeight,
      handleShadeWeight,
      handleShelterWeight,
    ],
  );

  // A key in the link wins; a missing one keeps what the sliders were last left at.
  const handleLink = useCallback((params: URLSearchParams): PlaceUrlState => {
    const stored: RouteUrlState = {
      start: null,
      dest: null,
      pin: null,
      weights: storedWeights(),
      customHour: null,
      customDay: null,
    };
    const route = decodeRoute(params, stored);
    setTreeWeight(route.weights.tree);
    setFerryWeight(route.weights.ferry);
    setLandmarkWeight(route.weights.landmark);
    setArtWeight(route.weights.art);
    setHighwayWeight(route.weights.highway);
    setHillWeight(route.weights.hill);
    setCommercialWeight(route.weights.commercial);
    setIndustrialWeight(route.weights.industrial);
    setHistoricWeight(route.weights.historic);
    setShadeWeight(route.weights.shade);
    setShelterWeight(route.weights.shelter);
    setAllowFerries(route.weights.allowFerries);
    setAllowSheds(route.weights.allowSheds);
    setAllowCrossings(route.weights.allowCrossings);
    const overlays = decodeView(params).overlays ?? storedOverlays();
    if (overlays) {
      // unknown ids (a stale "trees" from before the canopy switch) are dropped, and a set that
      // names an exclusive layer alongside others is cut back to it — the invariant the toggle
      // handler keeps has to hold however the set arrives
      setActiveOverlays(
        new Set(applyExclusivity(overlays.filter(isOverlayId))),
      );
    }
    return route;
  }, []);

  return (
    <MapShell
      weights={weights}
      activeOverlays={activeOverlays}
      onLink={handleLink}
      deck={(shell) => ({
        controls: (
          <ExplorerControls
            shell={shell}
            weights={weights}
            activeOverlays={activeOverlays}
            setActiveOverlays={setActiveOverlays}
            onToggleOverlay={handleToggleOverlay}
          />
        ),
        panels: (
          <ExplorerPanels
            shell={shell}
            weights={weights}
            onWeight={handleWeight}
            onGate={handleGate}
          />
        ),
      })}
    />
  );
}
