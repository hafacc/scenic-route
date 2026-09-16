"use client";

import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
} from "react";
import type { OverlayId } from "../../src/overlays/registry";
import { getPinnedTime } from "../../src/route-time/store";
import type { RouteWeights } from "../../src/routing/cost";
import type { FactorKey, GateKey } from "../../src/routing/factors";
import { encodeRoute, encodeView, shareUrl } from "../../src/url-state";
import GoogleMapsButton from "../google-maps-button";
import type { ShellDeck } from "../map-shell";
import SettingsDialog from "../settings-dialog";
import UrlSync from "../url-sync";
import { useSettings } from "../use-settings";
import RoutePanel from "./route-panel";
import Toolbar from "./toolbar";

interface ControlsProps {
  shell: ShellDeck;
  weights: RouteWeights;
  activeOverlays: ReadonlySet<OverlayId>;
  setActiveOverlays: Dispatch<SetStateAction<ReadonlySet<OverlayId>>>;
  onToggleOverlay: (id: OverlayId) => void;
}

interface PanelsProps {
  shell: ShellDeck;
  weights: RouteWeights;
  onWeight: (key: FactorKey, weight: number) => void;
  onGate: (key: GateKey, on: boolean) => void;
}

// The top of Explorer: the toolbar with its layers menu, and the writer that mirrors the route into
// the URL. The layer set is pruned here rather than where it is held, because the city that prunes
// it is the shell's.
export function ExplorerControls({
  shell,
  weights,
  activeOverlays,
  setActiveOverlays,
  onToggleOverlay,
}: ControlsProps) {
  const settings = useSettings();
  const { city } = shell;

  // Switching city swaps the whole layer set, so anything the new city does not offer goes off rather
  // than staying lit with no data behind it.
  useEffect(() => {
    setActiveOverlays((current) => {
      const kept = new Set(
        [...current].filter((id) => city.overlays.includes(id)),
      );
      return kept.size === current.size ? current : kept;
    });
  }, [city, setActiveOverlays]);

  // Taking a layer out of the menu turns it off, the same way switching city does: a layer drawn on
  // the map with no row to turn it off by is a state the reader cannot get out of. Putting it back in
  // the menu leaves it off rather than lighting it again — hiding is a decision about the menu, and
  // guessing that it was also a decision to look at the layer again would be putting something on the
  // map nobody asked for.
  useEffect(() => {
    const hidden = new Set(settings.hiddenLayers);
    setActiveOverlays((current) => {
      const kept = new Set([...current].filter((id) => !hidden.has(id)));
      return kept.size === current.size ? current : kept;
    });
  }, [settings.hiddenLayers, setActiveOverlays]);

  // The link the share button copies: the route the hash already carries, plus the camera and overlay
  // set, which live in a URL only here.
  const composeShareUrl = useCallback((): string => {
    const { hour, day } = getPinnedTime();
    const params = encodeRoute({
      start: shell.manualStart,
      dest: shell.dest,
      pin: shell.searchPin,
      weights,
      customHour: hour,
      customDay: day,
    });
    const camera = shell.camera();
    if (camera) {
      for (const [key, value] of encodeView(
        camera,
        [...activeOverlays],
        city.id,
      )) {
        params.append(key, value);
      }
    }
    return shareUrl(window.location, params);
  }, [shell, weights, activeOverlays, city]);

  return (
    <>
      <Toolbar
        auth={shell.auth}
        pinCount={shell.pinCount}
        city={city}
        activeOverlays={activeOverlays}
        routing={shell.routingOpen}
        refreshingClaims={shell.refreshingClaims}
        onToggleOverlay={onToggleOverlay}
        onToggleRouting={shell.onToggleRouting}
        onSignIn={shell.onSignIn}
        onSignOut={shell.onSignOut}
        onRefreshClaims={shell.onRefreshClaims}
        onAbout={shell.onAbout}
        onSettings={(section) => shell.onSettings(section ?? "")}
        onLogHere={shell.onLogHere}
        logHereDisabled={shell.logHereDisabled}
        logHereBusy={shell.logHereBusy}
        logHereHint={shell.logHereHint}
        onSelectCity={shell.onSelectCity}
        composeShareUrl={composeShareUrl}
      />
      <UrlSync
        start={shell.manualStart}
        dest={shell.dest}
        pin={shell.searchPin}
        weights={weights}
        enabled={shell.hashApplied}
      />
    </>
  );
}

// The bottom of Explorer: the route panel, and the settings dialog its rows link into.
export function ExplorerPanels({
  shell,
  weights,
  onWeight,
  onGate,
}: PanelsProps) {
  const { city, routeState } = shell;
  const routeResult = routeState.kind === "ready" ? routeState.result : null;
  // The graph the result was actually computed against, not whichever one state last landed on.
  const resultGraph = routeState.kind === "ready" ? routeState.graph : null;

  return (
    <>
      {shell.routingOpen ? (
        <RoutePanel
          city={city}
          exportAction={
            resultGraph && routeResult && shell.exportOrigin && shell.dest ? (
              <GoogleMapsButton
                graph={resultGraph}
                route={routeResult}
                weights={weights}
                start={shell.exportOrigin}
                dest={shell.dest}
              />
            ) : null
          }
          destPrefill={shell.destPrefill}
          startLabel={
            shell.manualStart
              ? shell.manualStart.label
              : shell.hasLiveLocation
                ? "My location"
                : null
          }
          destLabel={shell.dest?.label ?? null}
          startSet={shell.manualStart !== null}
          destSet={shell.dest !== null}
          needsStart={shell.manualStart === null && !shell.hasLiveLocation}
          hasLiveLocation={shell.hasLiveLocation}
          pickTarget={shell.pickTarget}
          status={routeState.kind}
          errorMessage={routeState.kind === "error" ? routeState.message : null}
          summary={
            routeState.kind === "ready"
              ? {
                  walkMeters: routeState.result.walkMeters,
                  travelSeconds: routeState.result.travelSeconds,
                  factors: routeState.result.factors,
                }
              : null
          }
          treeWeight={weights.tree}
          ferryWeight={weights.ferry}
          allowFerries={weights.allowFerries}
          landmarkWeight={weights.landmark}
          artWeight={weights.art}
          highwayWeight={weights.highway}
          hillWeight={weights.hill}
          capabilities={shell.capabilities}
          commercialWeight={weights.commercial}
          industrialWeight={weights.industrial}
          historicWeight={weights.historic}
          shadeWeight={weights.shade}
          shadeDataLost={shell.shadeDataLost}
          shelterWeight={weights.shelter}
          allowSheds={weights.allowSheds}
          allowCrossings={weights.allowCrossings}
          directions={shell.directions}
          progress={shell.progress}
          directionsOpen={shell.directionsOpen}
          minimized={shell.minimized}
          onTreeWeight={(weight) => onWeight("tree", weight)}
          onFerryWeight={(weight) => onWeight("ferry", weight)}
          onLandmarkWeight={(weight) => onWeight("landmark", weight)}
          onArtWeight={(weight) => onWeight("art", weight)}
          onHighwayWeight={(weight) => onWeight("highway", weight)}
          onHillWeight={(weight) => onWeight("hill", weight)}
          onCommercialWeight={(weight) => onWeight("commercial", weight)}
          onIndustrialWeight={(weight) => onWeight("industrial", weight)}
          onHistoricWeight={(weight) => onWeight("historic", weight)}
          onShadeWeight={(weight) => onWeight("shade", weight)}
          onShelterWeight={(weight) => onWeight("shelter", weight)}
          onGate={onGate}
          onStartSelect={shell.onStartSelect}
          onDestSelect={shell.onDestSelect}
          onStartClear={shell.onStartClear}
          onDestClear={shell.onDestClear}
          onSwap={shell.onSwap}
          onUseCurrentLocation={shell.onStartClear}
          onArmStart={shell.onArmStart}
          onArmDest={shell.onArmDest}
          onToggleDirections={shell.onToggleDirections}
          onToggleMinimize={shell.onToggleMinimize}
          onSettings={(section) => shell.onSettings(section ?? "")}
          onClose={shell.onToggleRouting}
        />
      ) : null}
      {shell.settingsSection !== null ? (
        <SettingsDialog
          weights={weights}
          onWeight={onWeight}
          onGate={onGate}
          syncingAs={shell.syncingAs}
          section={shell.settingsSection}
          onClose={() => shell.onSettings(null)}
        />
      ) : null}
    </>
  );
}
