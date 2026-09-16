"use client";

import { type ReactNode, useCallback, useEffect, useMemo } from "react";
import { modeIconHref } from "../../src/modes/favicon";
import {
  type ModeId,
  modeForCity,
  modesForCity,
  type Toggles,
} from "../../src/modes/modes";
import type { EndpointsKey } from "../../src/modes/selection";
import { EXPLORER_PAGE } from "../../src/pages";
import { encodeModes, encodeView, shareUrl } from "../../src/url-state";
import type { ShellDeck } from "../map-shell";
import SettingsDialog from "../settings-dialog";
import Toolbar from "../toolbar";
import UrlSync from "../url-sync";
import ModeBar from "./mode-bar";
import ModesPanel from "./panel";
import type { CardView } from "./route-cards";

// The chrome the floating controls all wear, worn here by the one bar the mode and its switches
// share — the same row the card heads with on a phone.
const FLOATING_BAR =
  "flex items-center rounded-full bg-white/85 px-2 py-1.5 shadow-lg ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-800/80 dark:ring-white/10";

export interface ModesState {
  // What the reader picked, which a city that does not offer it stands its own first mode in for.
  modeId: ModeId;
  toggles: Toggles;
  alt: number | null;
  cards: readonly CardView[];
  // Whether a sweep is running, and the summary of the max-scenic route it has already found.
  planning: boolean;
  planningLine: string | null;
  // Whether the card is on the directions screen with no destination in hand — a field the reader
  // has just emptied, which is a question rather than a way back to the search.
  directionsOpen: boolean;
  onMode: (id: ModeId) => void;
  onToggles: (toggles: Toggles) => void;
  onSelect: (index: number) => void;
  // Which card the pointer is over, whose line is drawn as the chosen one is for as long as it is.
  onHover: (index: number | null) => void;
  onBack: () => void;
  onClose: () => void;
  // The walk the cards are about; null while there is no destination, which is not a walk anyone
  // has moved away from.
  onEndpoints: (key: EndpointsKey | null) => void;
}

export function ModesControls({
  shell,
  state,
}: {
  shell: ShellDeck;
  state: ModesState;
}) {
  const { city } = shell;
  const { onEndpoints } = state;
  const modes = useMemo(() => modesForCity(city), [city]);
  const mode = useMemo(
    () => modeForCity(city, state.modeId),
    [city, state.modeId],
  );

  // The tab and the browser's own chrome follow the mode with everything else it colours. Both are
  // put back on the way out, so Explorer and the installed app keep the app's green.
  useEffect(() => {
    const icon =
      document.head.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    const themeColor = document.head.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]',
    );
    const iconWas = icon?.getAttribute("href") ?? null;
    const themeWas = themeColor?.getAttribute("content") ?? null;
    icon?.setAttribute("href", modeIconHref(mode.color));
    themeColor?.setAttribute("content", mode.color);
    return () => {
      if (iconWas !== null) {
        icon?.setAttribute("href", iconWas);
      }
      if (themeWas !== null) {
        themeColor?.setAttribute("content", themeWas);
      }
    };
  }, [mode.color]);

  // The two ends as separate strings so the effect can compare them without a new object every
  // render; the start is null while none has been named, which the promotion below then fills in.
  const startKey = shell.manualStart
    ? `${shell.manualStart.lat},${shell.manualStart.lng}`
    : null;
  const destKey = shell.dest ? `${shell.dest.lat},${shell.dest.lng}` : null;
  useEffect(() => {
    onEndpoints(destKey === null ? null : { start: startKey, dest: destKey });
  }, [startKey, destKey, onEndpoints]);

  // The route is already in the hash; the camera and the city live in a URL only here. The clock is
  // in neither: Modes routes at now, and `encodeModes` writes no hour.
  const composeShareUrl = useCallback((): string => {
    const params = encodeModes({
      start: shell.manualStart,
      dest: shell.dest,
      pin: shell.searchPin,
      mode: mode.id,
      alt: state.alt,
      toggles: state.toggles,
      customHour: null,
      customDay: null,
    });
    const camera = shell.camera();
    if (camera) {
      // The layers are the mode's, so the link says which mode rather than listing them.
      for (const [key, value] of encodeView(camera, [], city.id)) {
        if (key !== "layers") {
          params.append(key, value);
        }
      }
    }
    return shareUrl(window.location, params);
  }, [shell, mode, state.alt, state.toggles, city]);

  return (
    <>
      <Toolbar
        auth={shell.auth}
        pinCount={shell.pinCount}
        city={city}
        refreshingClaims={shell.refreshingClaims}
        otherPage={EXPLORER_PAGE}
        clock={false}
        controls={null}
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
      {/* Between the two button clusters, where there is room for four chips and the switches on a
          wide screen. On a phone the same row rides the head of the card instead. */}
      <div
        className={`absolute top-3 left-1/2 z-[1000] hidden max-w-[56vw] -translate-x-1/2 md:flex ${FLOATING_BAR}`}
      >
        <ModeBar
          modes={modes}
          mode={mode.id}
          toggles={state.toggles}
          available={shell.available}
          onMode={state.onMode}
          onToggles={state.onToggles}
        />
      </div>
      <UrlSync
        start={shell.manualStart}
        dest={shell.dest}
        pin={shell.searchPin}
        encode={() =>
          encodeModes({
            start: shell.manualStart,
            dest: shell.dest,
            pin: shell.searchPin,
            mode: mode.id,
            alt: state.alt,
            toggles: state.toggles,
            customHour: null,
            customDay: null,
          })
        }
        enabled={shell.hashApplied}
      />
    </>
  );
}

export function ModesPanels({
  shell,
  state,
  exportAction,
}: {
  shell: ShellDeck;
  state: ModesState;
  exportAction: ReactNode;
}) {
  const { city } = shell;
  const modes = useMemo(() => modesForCity(city), [city]);
  const mode = useMemo(
    () => modeForCity(city, state.modeId),
    [city, state.modeId],
  );

  // Which of the two screens the card is: a destination — from a link, from the search, or from a
  // tap on the map — is what turns finding a place into walking to one. Words a link carried that
  // resolved to nothing certain count as one, because the box they are typed into is the answer.
  const routing =
    shell.dest !== null || shell.destPrefill !== null || state.directionsOpen;
  const { onClose } = state;
  const { onToggleRouting } = shell;
  const close = useCallback(() => {
    onToggleRouting(); // the shell's own close: both ends, the route and the peek bar
    onClose();
  }, [onToggleRouting, onClose]);

  return (
    <>
      <ModesPanel
        city={city}
        modes={modes}
        mode={mode}
        onMode={state.onMode}
        toggles={state.toggles}
        available={shell.available}
        onToggles={state.onToggles}
        routing={routing}
        foundLabel={shell.searchPin?.label ?? null}
        onSearchSelect={shell.onSearchSelect}
        onSearchClear={shell.onSearchClear}
        onSearchDirections={shell.onSearchDirections}
        onClose={close}
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
        destPrefill={shell.destPrefill}
        status={shell.routeState.kind}
        errorMessage={
          shell.routeState.kind === "error" ? shell.routeState.message : null
        }
        planning={state.planning}
        planningLine={state.planningLine}
        cards={state.cards}
        selected={state.alt}
        directions={shell.directions}
        progress={shell.progress}
        minimized={shell.minimized}
        exportAction={exportAction}
        onSelect={state.onSelect}
        onHover={state.onHover}
        onBack={state.onBack}
        onStartSelect={shell.onStartSelect}
        onDestSelect={shell.onDestSelect}
        onStartClear={shell.onStartClear}
        onDestClear={shell.onDestClear}
        onSwap={shell.onSwap}
        onArmStart={shell.onArmStart}
        onArmDest={shell.onArmDest}
        onToggleMinimize={shell.onToggleMinimize}
      />
      {shell.settingsSection !== null ? (
        <SettingsDialog
          sections={["offline"]}
          syncingAs={shell.syncingAs}
          section={shell.settingsSection}
          onClose={() => shell.onSettings(null)}
        />
      ) : null}
    </>
  );
}
