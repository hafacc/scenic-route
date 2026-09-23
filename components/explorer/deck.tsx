"use client";

import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
} from "react";
import { ferrySummaries, rideSummaries } from "../../src/modes/cards";
import type { OverlayId } from "../../src/overlays/registry";
import { MODES_PAGE } from "../../src/pages";
import { getPinnedTime } from "../../src/route-time/store";
import type { RouteWeights } from "../../src/routing/cost";
import type { FactorKey, GateKey } from "../../src/routing/factors";
import { encodeRoute, encodeView, shareUrl } from "../../src/url-state";
import GoogleMapsButton from "../google-maps-button";
import type { ShellDeck } from "../map-shell";
import RouteToggle from "../route-toggle";
import SettingsDialog from "../settings-dialog";
import Toolbar from "../toolbar";
import UrlSync from "../url-sync";
import { useSettings } from "../use-settings";
import LayersControl from "./layers-control";
import RoutePanel from "./route-panel";

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

// Pruned here rather than where it is held, because the city that prunes it is the shell's.
export function ExplorerControls({
  shell,
  weights,
  activeOverlays,
  setActiveOverlays,
  onToggleOverlay,
}: ControlsProps) {
  const settings = useSettings();
  const { city } = shell;

  useEffect(() => {
    setActiveOverlays((current) => {
      const kept = new Set(
        [...current].filter((id) => city.overlays.includes(id)),
      );
      return kept.size === current.size ? current : kept;
    });
  }, [city, setActiveOverlays]);

  // Hiding a layer turns it off, since a drawn layer with no row can't be turned off.
  useEffect(() => {
    const hidden = new Set(settings.hiddenLayers);
    setActiveOverlays((current) => {
      const kept = new Set([...current].filter((id) => !hidden.has(id)));
      return kept.size === current.size ? current : kept;
    });
  }, [settings.hiddenLayers, setActiveOverlays]);

  // The camera and overlay set live in a URL only here.
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
        refreshingClaims={shell.refreshingClaims}
        otherPage={MODES_PAGE}
        clock
        controls={
          <>
            <RouteToggle
              active={shell.routingOpen}
              onToggle={shell.onToggleRouting}
            />
            <LayersControl
              city={city}
              active={activeOverlays}
              onToggle={onToggleOverlay}
              onSettings={(section) => shell.onSettings(section ?? "")}
            />
          </>
        }
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
        encode={(clock) =>
          encodeRoute({
            start: shell.manualStart,
            dest: shell.dest,
            pin: shell.searchPin,
            weights,
            customHour: clock.hour,
            customDay: clock.day,
          })
        }
        enabled={shell.hashApplied}
      />
    </>
  );
}

export function ExplorerPanels({
  shell,
  weights,
  onWeight,
  onGate,
}: PanelsProps) {
  const { city, routeState } = shell;

  return (
    <>
      {shell.routingOpen ? (
        <RoutePanel
          city={city}
          exportAction={
            routeState.kind === "ready" && shell.exportOrigin && shell.dest ? (
              <GoogleMapsButton
                plan={shell.waypointPlan}
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
                  rides: rideSummaries(routeState.result.rides),
                  ferries: ferrySummaries(routeState.result.ferries),
                  factors: routeState.result.factors,
                }
              : null
          }
          treeWeight={weights.tree}
          ferryWeight={weights.ferry}
          allowFerries={weights.allowFerries}
          transitWeight={weights.transit}
          landmarkWeight={weights.landmark}
          artWeight={weights.art}
          highwayWeight={weights.highway}
          hillWeight={weights.hill}
          graphAvailable={shell.graphAvailable}
          shedFeed={shell.shedFeed}
          commercialWeight={weights.commercial}
          industrialWeight={weights.industrial}
          historicWeight={weights.historic}
          bridgeWeight={weights.bridge}
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
          onTransitWeight={(weight) => onWeight("transit", weight)}
          onLandmarkWeight={(weight) => onWeight("landmark", weight)}
          onArtWeight={(weight) => onWeight("art", weight)}
          onHighwayWeight={(weight) => onWeight("highway", weight)}
          onHillWeight={(weight) => onWeight("hill", weight)}
          onCommercialWeight={(weight) => onWeight("commercial", weight)}
          onIndustrialWeight={(weight) => onWeight("industrial", weight)}
          onHistoricWeight={(weight) => onWeight("historic", weight)}
          onBridgeWeight={(weight) => onWeight("bridge", weight)}
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
