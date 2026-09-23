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
  DEFAULT_BRIDGE_WEIGHT,
  DEFAULT_COMMERCIAL_WEIGHT,
  DEFAULT_FERRY_WEIGHT,
  DEFAULT_HIGHWAY_WEIGHT,
  DEFAULT_HILL_WEIGHT,
  DEFAULT_HISTORIC_WEIGHT,
  DEFAULT_INDUSTRIAL_WEIGHT,
  DEFAULT_LANDMARK_WEIGHT,
  DEFAULT_SHADE_WEIGHT,
  DEFAULT_SHELTER_WEIGHT,
  DEFAULT_TRANSIT_WEIGHT,
  DEFAULT_TREE_WEIGHT,
  MAX_FERRY_WEIGHT,
  MAX_HIGHWAY_WEIGHT,
  MAX_HILL_WEIGHT,
  MAX_INDUSTRIAL_WEIGHT,
  MAX_SHADE_WEIGHT,
  MAX_SHELTER_WEIGHT,
  MAX_TRANSIT_WEIGHT,
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

// What a URL key overrides and a missing one leaves in place.
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
    bridge: read("bridge", DEFAULT_BRIDGE_WEIGHT, 0, 1),
    shade: read(
      "shade",
      DEFAULT_SHADE_WEIGHT,
      -MAX_SHADE_WEIGHT,
      MAX_SHADE_WEIGHT,
    ),
    shelter: read("shelter", DEFAULT_SHELTER_WEIGHT, 0, MAX_SHELTER_WEIGHT),
    transit: read("transit", DEFAULT_TRANSIT_WEIGHT, 0, MAX_TRANSIT_WEIGHT),
    allowFerries,
    // Never a stored preference: the planner owns it (routing/cost.ts, INTERNAL_FLAGS).
    allowTransit: true,
    allowSheds,
    allowCrossings,
  };
}

// A weight nobody has moved stays out of the document and keeps its built-in default.
function persistWeight(key: FactorKey, weight: number): void {
  updateSettings({ weights: { ...storedSettings().weights, [key]: weight } });
}

// null when nothing was ever stored; an empty string is a deliberate all-off.
function storedOverlays(): string[] | null {
  const stored = window.localStorage.getItem(OVERLAY_KEY);
  return stored === null ? null : stored.split(",");
}

export default function Explorer() {
  // Canopy starts on because it is all a signed-out visitor has.
  const [activeOverlays, setActiveOverlays] = useState<ReadonlySet<OverlayId>>(
    () => new Set<OverlayId>(["canopy"]),
  );
  const [treeWeight, setTreeWeight] = useState<number>(DEFAULT_TREE_WEIGHT);
  const [ferryWeight, setFerryWeight] = useState<number>(DEFAULT_FERRY_WEIGHT);
  const [allowFerries, setAllowFerries] = useState<boolean>(true);
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
  const [bridgeWeight, setBridgeWeight] = useState<number>(
    DEFAULT_BRIDGE_WEIGHT,
  );
  // −1 = prefer shade, +1 = prefer sun, 0 = off; the shell follows the clock while this is set.
  const [shadeWeight, setShadeWeight] = useState<number>(DEFAULT_SHADE_WEIGHT);
  // Both read the per-edge shed coverage, which moves only with the picked day.
  const [shelterWeight, setShelterWeight] = useState<number>(
    DEFAULT_SHELTER_WEIGHT,
  );
  const [allowSheds, setAllowSheds] = useState<boolean>(true);
  // Opens at its maximum: this is a walking map.
  const [transitWeight, setTransitWeight] = useState<number>(
    DEFAULT_TRANSIT_WEIGHT,
  );
  const [allowCrossings, setAllowCrossings] = useState<boolean>(false);

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
      bridge: bridgeWeight,
      shade: shadeWeight,
      shelter: shelterWeight,
      transit: transitWeight,
      allowFerries,
      allowTransit: true,
      allowSheds,
      allowCrossings,
    }),
    [
      allowCrossings,
      transitWeight,
      treeWeight,
      ferryWeight,
      landmarkWeight,
      artWeight,
      highwayWeight,
      hillWeight,
      commercialWeight,
      industrialWeight,
      historicWeight,
      bridgeWeight,
      shadeWeight,
      shelterWeight,
      allowFerries,
      allowSheds,
    ],
  );

  // Tree genus is exclusive both ways, so its dense recoloring never fights the other overlays.
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

  const handleBridgeWeight = useCallback((weight: number) => {
    setBridgeWeight(weight);
    persistWeight("bridge", weight);
  }, []);

  const handleShadeWeight = useCallback((weight: number) => {
    setShadeWeight(weight);
    persistWeight("shade", weight);
  }, []);

  const handleShelterWeight = useCallback((weight: number) => {
    setShelterWeight(weight);
    persistWeight("shelter", weight);
  }, []);

  const handleTransitWeight = useCallback((weight: number) => {
    setTransitWeight(weight);
    persistWeight("transit", weight);
  }, []);

  const handleGate = useCallback((key: GateKey, on: boolean) => {
    const setters: Record<GateKey, (on: boolean) => void> = {
      allowFerries: setAllowFerries,
      allowSheds: setAllowSheds,
      allowCrossings: setAllowCrossings,
    };
    setters[key](on);
    updateSettings({ [key]: on });
  }, []);

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
        bridge: handleBridgeWeight,
        shade: handleShadeWeight,
        shelter: handleShelterWeight,
        transit: handleTransitWeight,
      };
      setters[key](weight);
    },
    [
      handleTransitWeight,
      handleTreeWeight,
      handleFerryWeight,
      handleLandmarkWeight,
      handleArtWeight,
      handleHighwayWeight,
      handleHillWeight,
      handleCommercialWeight,
      handleIndustrialWeight,
      handleHistoricWeight,
      handleBridgeWeight,
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
    setBridgeWeight(route.weights.bridge);
    setShadeWeight(route.weights.shade);
    setShelterWeight(route.weights.shelter);
    setTransitWeight(route.weights.transit);
    setAllowFerries(route.weights.allowFerries);
    setAllowSheds(route.weights.allowSheds);
    setAllowCrossings(route.weights.allowCrossings);
    const overlays = decodeView(params).overlays ?? storedOverlays();
    if (overlays) {
      // Unknown ids (e.g. a stale "trees") are dropped, and exclusivity applies as in the toggle.
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
