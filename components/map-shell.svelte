<script lang="ts">
import { type Component, onMount } from "svelte";
import { browser } from "$app/env";
import {
  CITY_ZOOM,
  type City,
  type CityBounds,
  citiesInView,
  containsPoint,
  DEFAULT_CITY,
  nearestCity,
  setActiveCity,
} from "../src/cities";
import {
  createPin,
  deletePin,
  flushPendingFeedback,
  refreshClaims,
  signOutUser,
  updatePin,
  watchAuth,
  watchPins,
} from "../src/firebase";
import {
  type GeocodeResult,
  INDEX_RESULT_TYPE,
  resolveSharedQuery,
  reverseGeocode,
  searchAddress,
} from "../src/geocode";
import { FiX } from "../src/icons/glyphs";
import {
  cityFactors,
  type FactorAvailability,
  graphFactors,
} from "../src/lenses/lenses";
import { OVERLAYS, type OverlayId } from "../src/overlays/registry";
import type { Pin } from "../src/pin";
import {
  getResolvedDate,
  setCustomDay,
  setCustomHour,
  subscribeRouteTime,
} from "../src/route-time/store";
import {
  followsRouteTime,
  type RouteClock,
  RouteContexts,
} from "../src/routing/contexts";
import type { RouteWeights } from "../src/routing/cost";
import { buildDirections } from "../src/routing/directions";
import type { RoutingGraph } from "../src/routing/graph";
import { navProgress } from "../src/routing/nav-progress";
import { loadPois, type PoiSet, passedPois } from "../src/routing/pois";
import { routerClient } from "../src/routing/router-client";
import type { RouteResult } from "../src/routing/search";
import { snapPair } from "../src/routing/snap";
import type { WaypointPlan } from "../src/routing/waypoints";
import {
  awaitNameIndex,
  prefetchNameIndex,
  releaseNameIndex,
  setSearchCenter,
  warmNameIndex,
} from "../src/search/name-search";
import {
  startSettingsSync,
  stopSettingsSync,
} from "../src/settings/sync-session";
import { sharedDestinationText, withoutShareParams } from "../src/share-target";
import {
  type Camera,
  decodeDestQuery,
  decodeView,
  hashParams,
  type LatLng,
  withoutDestQuery,
} from "../src/url-state";
import AboutDialog from "./about-dialog.svelte";
import { setCity as provideCity } from "./city-context";
import FollowToggle from "./follow-toggle.svelte";
import Icon from "./icon.svelte";
import LayerLegend from "./layer-legend.svelte";
import type { MapTarget, SearchPin } from "./map-types";
import { OVERLAY_VIEWS } from "./overlay-views";
import PinEditor from "./pin-editor.svelte";
import SearchControl from "./search-control.svelte";
import {
  ART_PASS_METERS,
  accentVars,
  LANDMARK_PASS_METERS,
  loadRouting,
  messageFor,
  SEARCH_PIN_ZOOM,
} from "./shell-helpers";
import {
  frameLink,
  leavesRoute,
  liveStartToPin,
  NO_START,
  placeFirstFix,
  planSolve,
  type RoutedPair,
  relabel,
  resolveStart,
  shownStart,
  swapEndpoints,
  tapFollow,
} from "./shell-logic";
import type {
  AuthState,
  DestPrefill,
  Editing,
  Endpoint,
  MapShellProps,
  RouteState,
  ShellDeck,
  SolveReply,
} from "./shell-types";
import SignInDialog from "./sign-in-dialog.svelte";
import { useHashFlag, useHashSection } from "./use-hash-flag.svelte";
import { useStandalone } from "./use-install.svelte";

// One object, so going idle again notifies nobody.
const IDLE: RouteState = { kind: "idle" };

const {
  weights: weightsProp,
  activeOverlays: overlaysProp,
  onLink,
  controls,
  panels,
  solve,
  chosen,
  lines,
  onSelectLine,
  onHoverLine,
  onRoutingReset,
  legends = "bottom-left",
  ownSearch = true,
  alwaysRouting = false,
  accent: accentProp,
  tapSearch = false,
  liveDrag = true,
  legend,
  clock: clockProp = null,
}: MapShellProps = $props();

// Leaflet touches `window` at module load, so the map must be client-only.
const mapView = browser ? import("./map.svelte") : new Promise<never>(() => {});

let auth = $state.raw<AuthState>({ kind: "loading" });
let pins = $state.raw<Pin[]>([]);
let editing = $state.raw<Editing>(null);
let target = $state.raw<MapTarget | null>(null);
let userLocation = $state.raw<{
  lat: number;
  lng: number;
} | null>(null);
let logging = $state.raw<boolean>(false);
let refreshing = $state.raw<boolean>(false);
let following = $state.raw<boolean>(true);
// Follows the map center, so panning to another city switches to it.
let city = $state.raw<City>(DEFAULT_CITY);
provideCity(() => city);
let signingIn = $state.raw<boolean>(false);
const about = useHashFlag("about");
const settings = useHashSection("settings");
let locationError = $state.raw<"denied" | "unavailable" | null>(null);
const standalone = useStandalone();
let banner = $state.raw<string | null>(null);
// A map chunk that never arrives would otherwise leave the page blank and silent.
mapView.catch(() => {
  banner = "Couldn't load the map. Check your connection and reload.";
});
// The basemap has no menu row to badge, so it gets the banner.
function handleBasemapLost(lost: boolean): void {
  if (lost) {
    banner = "Map background unavailable — check your connection.";
  }
}
let routingWanted = $state.raw<boolean>(false);
const routingOpen = $derived(alwaysRouting || routingWanted);
// Search and directions share one panel slot: opening either closes the other.
let searchOpen = $state.raw<boolean>(false);
let manualStart = $state.raw<Endpoint | null>(null);
let dest = $state.raw<Endpoint | null>(null);
let pickTarget = $state.raw<"start" | "dest" | null>(null);
// Held in state, since the URL is stripped once read and the city can still change.
let destQuery = $state.raw<string | null>(null);
let destPrefill = $state.raw<DestPrefill | null>(null);
// The sun/shade field is refetched as the clock moves, so it can fail with the graph healthy.
let shadeDataLost = $state.raw<boolean>(false);
let routeTimeTick = $state.raw<number>(0);
let routingGraph = $state.raw<RoutingGraph | null>(null);
// Until the graph lands, the city's authored layer list stands in.
const available: FactorAvailability = $derived(
  routingGraph ? graphFactors(routingGraph) : cityFactors(city),
);
const weights: RouteWeights = $derived(
  typeof weightsProp === "function"
    ? weightsProp({ city, available })
    : weightsProp,
);
const activeOverlays: ReadonlySet<OverlayId> = $derived(
  typeof overlaysProp === "function"
    ? overlaysProp({ city, available })
    : overlaysProp,
);
const accentHex: string | null = $derived(
  (typeof accentProp === "function"
    ? accentProp({ city, available })
    : accentProp) ?? null,
);
const accent: string | undefined = $derived(
  accentHex === null ? undefined : accentVars(accentHex),
);
let poiSets = $state.raw<{
  landmarks: PoiSet;
  art: PoiSet;
} | null>(null);
let directionsOpen = $state.raw<boolean>(false);
let panelMinimized = $state.raw<boolean>(false);
let routeState = $state.raw<RouteState>(IDLE);
// Last-routed endpoints, so a slider move recomputes without a loading flash.
let routedFor: RoutedPair | null = null;
// For the maneuver list (ferry timetable) and the Google Maps export; the worker has its own.
let routeContexts: RouteContexts | null = new RouteContexts();
// Holds the drawn route during a drag instead of flashing a loading state each frame.
let midDrag = false;
let dragWhich = $state.raw<"start" | "dest">("dest");
let dragging = $state.raw<boolean>(false);
// Bumped on drop to rerun the exact recompute, since a start drop leaves the endpoints unchanged.
let routeRefreshNonce = $state.raw<number>(0);
// Tells a drop (lands silently) from a fresh target (shows the loading spinner).
let lastAppliedNonce = 0;
// The start the drawn route was asked from, which trails the one asked for after a swap.
let routedFrom = $state.raw<LatLng | null>(null);
// The destination the drawn route was asked for, so the map never frames the one it replaces.
let routedTo = $state.raw<LatLng | null>(null);
let hashApplied = $state.raw<boolean>(false);
// A stored city doesn't count: the live position is a better answer.
let linkedCity = false;
// Only the first location fix decides the city.
let coverageChecked = false;
// Applied once by the map; null lets a fresh route frame itself.
let initialCamera = $state.raw<Camera | null>(null);
let preframedDest = $state.raw<LatLng | null>(null);
// Outlives the panel closing; a second search replaces it.
let searchPin = $state.raw<SearchPin | null>(null);
// A plain variable, so a pan invalidates nothing.
let lastCamera: Camera | null = null;

// A hand-armed start still sets the start.
const tapFindsPlace = $derived(
  tapSearch && pickTarget === "dest" && dest === null && destPrefill === null,
);

// A boolean, so the deck's fresh weights object on every slider move doesn't resubscribe.
const followsClock = $derived(followsRouteTime(weights));
// Each tick re-costs against the sun and the next sailing; a new day restands the scaffolding.
$effect(() => {
  if (followsClock) {
    return subscribeRouteTime(() => {
      routeTimeTick += 1;
    });
  }
});

// An offline note waits in Firestore's cache until something builds the Firestore instance.
onMount(() => {
  flushPendingFeedback().catch(() => {});
});

onMount(() =>
  watchAuth((info) => {
    // onIdTokenChanged re-fires each refresh; keep the old ref when uid and admin match.
    if (!info) {
      if (auth.kind !== "signedOut") {
        auth = { kind: "signedOut" };
      }
    } else if (
      auth.kind !== "signedIn" ||
      auth.info.user.uid !== info.user.uid ||
      auth.info.admin !== info.admin
    ) {
      auth = { kind: "signedIn", info };
    }
  }),
);

// Keyed on the uid, not the auth object, which is replaced on every token refresh.
const uid = $derived(auth.kind === "signedIn" ? auth.info.user.uid : null);
$effect(() => {
  if (uid === null) {
    stopSettingsSync();
  } else {
    startSettingsSync(uid);
    return stopSettingsSync;
  }
});

// iOS copies cookies from Safari only at install, so the installed app has its own permissions.
const locationHint = $derived(
  locationError === "denied"
    ? standalone.current
      ? "Location is blocked for this app — allow it in iOS Settings › Privacy & Security › Location Services › Scenic Route, then tap the location button. If Scenic Route is not listed, remove it from the Home Screen and add it again."
      : "Location access is blocked — enable it in your browser settings."
    : locationError === "unavailable"
      ? "Couldn't get your location. Make sure location services are on."
      : null,
);

// The same refusal again leaves a dismissed banner dismissed; `retryLocation` clears it to ask afresh.
function failLocation(error: GeolocationPositionError): void {
  const kind =
    error.code === error.PERMISSION_DENIED ? "denied" : "unavailable";
  if (locationError !== kind) {
    locationError = kind;
    banner = locationHint;
  }
}

const isAdmin = $derived(auth.kind === "signedIn" && auth.info.admin);

$effect(() => {
  if (!isAdmin) {
    return;
  }
  const unsubscribe = watchPins(
    (next) => {
      pins = next;
    },
    () => {
      banner = "Live updates stopped. Reload the page to reconnect.";
    },
  );
  return () => {
    unsubscribe();
    pins = [];
  };
});

// Registered again on a retry, or allowing location in Settings waits for a relaunch.
let stopLocating: (() => void) | null = null;
function locate(): void {
  stopLocating?.();
  stopLocating = null;
  if (!("geolocation" in navigator)) {
    return;
  }
  const watchId = navigator.geolocation.watchPosition(
    (position) => {
      const lat = position.coords.latitude;
      const lng = position.coords.longitude;
      userLocation = { lat, lng };
      locationError = null;
      // Only the first fix picks the city, and only if the link named none; else the nearest.
      if (!coverageChecked) {
        coverageChecked = true;
        const placed = placeFirstFix({ lat, lng }, linkedCity);
        if (placed) {
          if (!placed.follow) {
            following = false;
          }
          if (placed.move) {
            enterCity(placed.move.city);
            target = placed.move.target;
          }
        }
      }
    },
    failLocation,
    { enableHighAccuracy: false, maximumAge: 30_000 },
  );
  stopLocating = () => navigator.geolocation.clearWatch(watchId);
}
onMount(() => {
  locate();
  return () => stopLocating?.();
});

// A fix outside the active city is not a start, a center, or a "My location".
const routableLocation = $derived(
  userLocation && containsPoint(city, userLocation) ? userLocation : null,
);

// Armed before the first fix so the map flies to it; derived, so the map never follows a fix outside the city.
const followLive = $derived(
  following && (userLocation === null || routableLocation !== null),
);
// What the button says: it follows nothing until there is a location.
const followShown = $derived(following && routableLocation !== null);

// Every destination write lands here: a moved one shuts the turn list, a relabel doesn't.
function placeDest(next: Endpoint | null): void {
  if (next?.lat !== dest?.lat || next?.lng !== dest?.lng) {
    directionsOpen = false;
  }
  dest = next;
}

// Clears everything but the slider values.
function closeRouting(): void {
  placeDest(null);
  manualStart = null;
  pickTarget = null;
  routeState = IDLE;
  routedFor = null;
  // The peek bar means nothing over an empty panel.
  panelMinimized = false;
  routingWanted = false;
}

// Every city change lands here: the route, search pin, graph and POIs belong to the city left.
function enterCity(next: City): void {
  if (next.id === city.id) {
    return;
  }
  const closeRoute = leavesRoute(dest, manualStart);
  city = next;
  // Moved now, since a lookup issued in this same turn reads the global before any effect runs.
  setActiveCity(next);
  if (closeRoute) {
    closeRouting();
    routerClient().reset();
    onRoutingReset?.();
  }
  searchPin = null;
  poiSets = null;
  // Null until this city's graph lands, or sliders stay lit for data the new city lacks.
  routingGraph = null;
}

// Clearing the error first lets a second refusal re-raise a dismissed banner.
function retryLocation(): void {
  if (userLocation === null) {
    locationError = null;
    locate();
  }
}

// Engaging from outside the active city moves the city with the camera.
function handleToggleFollow(): void {
  const tap = tapFollow(following, userLocation, routableLocation !== null);
  following = tap !== "release";
  if (tap === "locate") {
    retryLocation();
  } else if (tap === "enter" && userLocation) {
    enterCity(nearestCity(userLocation));
  }
}

function handleSelectCity(picked: City): void {
  following = false;
  enterCity(picked);
  target = { ...picked.center, zoom: CITY_ZOOM };
}

// Assigned ahead of the layers, which read it in their own effects.
$effect.pre(() => {
  setActiveCity(city);
});

// Prefetched on idle so offline search works: ten megabytes against the graph's thirty-nine.
$effect(() => {
  const cityId = city.id;
  const prefetch = () => {
    void prefetchNameIndex(cityId);
  };
  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(prefetch, { timeout: 5000 });
    return () => cancelIdleCallback(handle);
  } else {
    const handle = window.setTimeout(prefetch, 2000);
    return () => window.clearTimeout(handle);
  }
});

// The decoded index is 40 MB, so it is held only while a panel is open, or iOS kills the session.
$effect(() => {
  if (routingOpen || searchOpen) {
    warmNameIndex(city.id);
  } else {
    releaseNameIndex();
  }
});

// Stable identity for a long-lived map listener.
function handleDisengageFollow(): void {
  following = false;
}

// Remembers its last answer, so a fix inside the resnap threshold hands back the same point.
let startHold = NO_START;
const resolvedStart = $derived.by(() => {
  startHold = resolveStart(startHold, manualStart, routableLocation);
  return startHold.point;
});

// One departure instant for the page and the worker, read again only when the tick moves.
const liveClock: RouteClock = $derived({
  tick: routeTimeTick,
  dateMs: getResolvedDate().getTime(),
});
const routeClock = $derived(clockProp ?? liveClock);

// All false until the graph lands.
const graphAvailable: FactorAvailability = $derived(graphFactors(routingGraph));
// Sheds are fetched apart from the graph, so the scaffolding gate asks the city's overlay list.
const shedFeed = $derived(city.overlays.includes("scaffolding"));

// rAF-coalesced, so a slider drag computes at most once per frame.
$effect(() => {
  // Read up front: these are what a request is made of, so a change in any asks again.
  const cost = weights;
  const clock = routeClock;
  const nonce = routeRefreshNonce;
  // Captured, since the `activeCity()` global can move while a graph fetch is in flight.
  const routeCity = city;
  // A deck that replans on the drop holds the plan on screen while the marker moves.
  const plan = planSolve(resolvedStart, dest, routedFor, !liveDrag && midDrag);
  if (plan.kind === "idle") {
    routeState = IDLE;
    routedFor = null;
    return;
  } else if (plan.kind === "hold") {
    return;
  }
  const { request, isNewTarget } = plan;
  let canceled = false;
  const frame = requestAnimationFrame(() => {
    // A drop's recompute lands silently so the drawn route holds until the exact one is ready.
    const isDropRefresh = nonce !== lastAppliedNonce;
    lastAppliedNonce = nonce;
    if (isNewTarget && !midDrag && !isDropRefresh) {
      routeState = { kind: "loading" };
    }
    // With nothing drawn, whatever appears next (a deck's preview) answers this request.
    if (routeResult === null) {
      routedTo = request.dest;
    }
    loadRouting(routeCity.id)
      .then(
        async ({ graph, index }) => {
          if (canceled) {
            return;
          }
          // `loadRouting` returns one stable graph per city, so never keep the first one.
          routingGraph = graph;
          routedFor = request;
          const client = routerClient();
          // Awaited so a graph the worker can't decode reaches the panel as an error.
          await client.load(routeCity.id, graph);
          if (canceled) {
            return;
          }
          const contexts = (routeContexts ??= new RouteContexts());
          // The timetable alone; the worker builds every costed field on its own copy.
          await contexts.syncFerries(graph, routeCity, clock, cost);
          if (canceled) {
            return;
          }
          const pair = snapPair(graph, index, request.start, request.dest);
          if (!pair.ok) {
            const offending =
              pair.reason === "startTooFar"
                ? request.start
                : pair.reason === "destTooFar"
                  ? request.dest
                  : null;
            routeState = {
              kind: "error",
              message: messageFor(pair.reason, routeCity, offending),
            };
            return;
          }
          const which = dragWhich;
          // Mid-drag the worker reuses a per-gesture solver for an approximate route.
          const solveOne = solve;
          // The deck's own solver runs on this thread; the worker gets only the endpoints.
          let reply: SolveReply | null;
          if (midDrag) {
            reply = await client.dragMove({
              cityId: routeCity.id,
              clock,
              weights: cost,
              anchor: which === "dest" ? pair.start : pair.dest,
              moving: which === "dest" ? pair.dest : pair.start,
              anchorSeconds:
                routeState.kind === "ready"
                  ? routeState.result.travelSeconds
                  : 0,
            });
          } else if (solveOne) {
            reply = await solveOne({
              city: routeCity,
              clock,
              weights: cost,
              start: pair.start,
              dest: pair.dest,
              graph,
            });
          } else {
            reply = await client.route({
              cityId: routeCity.id,
              clock,
              weights: cost,
              start: pair.start,
              dest: pair.dest,
            });
          }
          // Null means a newer frame overtook this one in the worker.
          if (canceled || !reply) {
            return;
          }
          routedFrom = request.start;
          routedTo = request.dest;
          // Only on a rebuild, or a slow failure after a success grays out a working slider.
          if (reply.shadeRebuilt) {
            shadeDataLost = reply.shadeLost ?? false;
          }
          // Always apply when nothing is drawn, or the loading state would strand.
          if (reply.changed || routeState.kind !== "ready") {
            if (reply.result) {
              routeState = { kind: "ready", result: reply.result, graph };
            } else {
              routeState = {
                kind: "error",
                message: messageFor("disconnected", routeCity, null),
              };
            }
          }
        },
        () => {
          if (!canceled) {
            routeState = {
              kind: "error",
              message: "Couldn't load the routing data. Check your connection.",
            };
          }
        },
      )
      .catch((error: unknown) => {
        // A worker refusal isn't a network failure, but the panel has one way to say so.
        console.error("routing failed:", error);
        if (!canceled) {
          routeState = {
            kind: "error",
            message: "Couldn't load the routing data. Check your connection.",
          };
        }
      });
  });
  return () => {
    canceled = true;
    cancelAnimationFrame(frame);
  };
});

function handleToggleDirections(): void {
  directionsOpen = !directionsOpen;
}

function handleToggleMinimize(): void {
  panelMinimized = !panelMinimized;
}

// Retires any link query, so a lookup still running can't overwrite the reader's answer.
function forgetDestQuery(): void {
  destQuery = null;
  destPrefill = null;
}

function handleDestSelect(result: GeocodeResult): void {
  placeDest({ lat: result.lat, lng: result.lng, label: result.displayName });
  pickTarget = null;
  forgetDestQuery();
}

function handleStartSelect(result: GeocodeResult): void {
  manualStart = {
    lat: result.lat,
    lng: result.lng,
    label: result.displayName,
  };
  pickTarget = null;
}

function handleClearDest(): void {
  placeDest(null);
  if (pickTarget === "dest") {
    pickTarget = null;
  }
  forgetDestQuery();
}

// Clearing the start routes from the live fix, so it asks for one when there is none.
function handleClearStart(): void {
  manualStart = null;
  if (pickTarget === "start") {
    pickTarget = null;
  }
  retryLocation();
}

// Costs are directional (hills, ferries, sun), so the way back is a new search.
function handleSwapEndpoints(): void {
  const swapped = swapEndpoints(manualStart, dest);
  manualStart = swapped.manualStart;
  placeDest(swapped.dest);
  pickTarget = null;
  forgetDestQuery();
}

function handleArmStart(): void {
  pickTarget = pickTarget === "start" ? null : "start";
}

function handleArmDest(): void {
  pickTarget = pickTarget === "dest" ? null : "dest";
}

function applyPick(target: "start" | "dest", lat: number, lng: number): void {
  // Immediate feedback; the reverse geocode replaces it.
  const pinned = { lat, lng, label: "Dropped pin" };
  if (target === "start") {
    manualStart = pinned;
  } else {
    placeDest(pinned);
    forgetDestQuery();
  }
  reverseGeocode(lat, lng)
    .then((place) => {
      if (!place) {
        return;
      }
      if (target === "start") {
        manualStart = relabel(manualStart, pinned, place.displayName);
      } else {
        placeDest(relabel(dest, pinned, place.displayName));
      }
    })
    .catch(() => {});
}

function dropSearchPin(lat: number, lng: number): void {
  searchPin = { lat, lng, label: "Dropped pin" };
  reverseGeocode(lat, lng)
    .then((place) => {
      if (place) {
        searchPin = relabel(searchPin, { lat, lng }, place.displayName);
      }
    })
    .catch(() => {});
}

// An effect, since a new fix restores it as much as a new destination or a cleared start does.
$effect(() => {
  const live = liveStartToPin(dest, manualStart, routableLocation);
  if (live) {
    applyPick("start", live.lat, live.lng);
  }
});

// Keeps the prior label until the drag settles, rather than reverse geocoding per frame.
function handleEndpointDragMove(
  which: "start" | "dest",
  lat: number,
  lng: number,
): void {
  if (!midDrag && liveDrag) {
    routerClient().dragStart(which);
  }
  midDrag = true;
  dragWhich = which;
  dragging = true;
  handleDisengageFollow();
  if (which === "start") {
    manualStart = { lat, lng, label: manualStart?.label ?? null };
  } else {
    placeDest({ lat, lng, label: dest?.label ?? null });
  }
}

// The drag bypassed the route cache, whose stale baseline would call the exact route unchanged.
function handleEndpointDrag(
  which: "start" | "dest",
  lat: number,
  lng: number,
): void {
  midDrag = false;
  dragging = false;
  handleDisengageFollow();
  applyPick(which, lat, lng);
  const client = routerClient();
  if (liveDrag) {
    client.dragEnd();
  }
  client.reset();
  routeRefreshNonce += 1;
}

// A link's keys win over stored values; the hash writer is enabled only after.
onMount(() => {
  const params = hashParams(window.location.hash);
  const route = onLink(params);
  if (route.customHour !== null) {
    setCustomHour(route.customHour);
  }
  if (route.customDay !== null) {
    setCustomDay(route.customDay);
  }
  const frame = frameLink(decodeView(params), route);
  linkedCity = frame.city !== null;
  // The city first, so the link's places are set, named and kept in it.
  if (frame.city) {
    enterCity(frame.city);
  }
  if (route.start) {
    applyPick("start", route.start.lat, route.start.lng);
  }
  if (route.pin) {
    // The point is the index's own coordinates, so the lookup lands on the row the sharer picked.
    dropSearchPin(route.pin.lat, route.pin.lng);
  }
  if (route.dest) {
    applyPick("dest", route.dest.lat, route.dest.lng);
    routingWanted = true;
    void loadRouting(city.id);
  }
  if (!frame.follow) {
    following = false;
  }
  initialCamera = frame.camera;
  preframedDest = frame.preframedDest;
  readDestQuery();
  hashApplied = true;
});

// Read once and stripped from the URL so a link can't fire twice or be passed on.
function readDestQuery(): void {
  const asked =
    decodeDestQuery(hashParams(window.location.hash)) ??
    sharedDestinationText(new URLSearchParams(window.location.search));
  if (asked === null) {
    return;
  }
  routingWanted = true;
  destQuery = asked;
  destPrefill = { text: asked, results: [] };
  // The entry's own state is kept, which is where SvelteKit's router holds its history index.
  window.history.replaceState(
    window.history.state,
    "",
    window.location.pathname +
      withoutShareParams(window.location.search) +
      withoutDestQuery(window.location.hash),
  );
}

// Only an exact house number is routed to, since silently routing to one of eleven is worse.
$effect(() => {
  const asked = destQuery;
  if (asked === null) {
    return;
  }
  let canceled = false;
  const cityId = city.id;
  // Waits for the index: a cold link would otherwise answer "nothing found" for a real address.
  awaitNameIndex(cityId)
    .then(() =>
      resolveSharedQuery(asked, cityId, searchAddress, () => canceled),
    )
    .then((found) => {
      if (canceled || found === null) {
        return;
      }
      destQuery = null;
      if (found.exact === null) {
        destPrefill = { text: found.query, results: found.results };
      } else {
        const { lat, lng, displayName } = found.exact;
        placeDest({ lat, lng, label: displayName });
        destPrefill = null;
      }
    });
  return () => {
    canceled = true;
  };
});

function handleCamera(camera: Camera, view: CityBounds): void {
  lastCamera = camera;
  // The first report comes from the container's default center, before the link is read.
  if (!hashApplied) {
    return;
  }
  // A settled camera reports several times per tick; the same city again changes nothing.
  const inView = citiesInView(view);
  if (inView.length === 1) {
    const [next] = inView;
    // The address search ranks same-named streets by distance from it.
    setSearchCenter(next.id, camera.center);
    enterCity(next);
  }
}

// A function, since the camera is no signal: the search box asks when it needs the center.
function mapCenter(): LatLng | null {
  return lastCamera?.center ?? null;
}

function camera(): Camera | null {
  return lastCamera;
}

// A tap places nothing unless a field is armed.
function handleMapPick(lat: number, lng: number): void {
  if (pickTarget === null) {
    return;
  } else if (tapFindsPlace) {
    // The same answer a suggestion gives, so a tap never opens directions on its own.
    dropSearchPin(lat, lng);
    pickTarget = null;
  } else {
    applyPick(pickTarget, lat, lng);
    pickTarget = null;
  }
}

async function handleLogHere(): Promise<void> {
  // Read now: the fallback below runs up to ten seconds later, and means the fix known at the tap.
  const watched = userLocation;
  const openEditorAt = async (lat: number, lng: number) => {
    let address = "Unknown location";
    try {
      const result = await reverseGeocode(lat, lng);
      if (result) {
        address = result.displayName;
      }
    } catch {}
    editing = { mode: "create", draft: { lat, lng, address, text: "" } };
  };
  if (!("geolocation" in navigator)) {
    return;
  }
  logging = true;
  navigator.geolocation.getCurrentPosition(
    async (position) => {
      try {
        await openEditorAt(position.coords.latitude, position.coords.longitude);
      } finally {
        logging = false;
      }
    },
    async (error) => {
      try {
        // High-accuracy fix failed; fall back to the last watched position.
        if (watched) {
          await openEditorAt(watched.lat, watched.lng);
        } else {
          failLocation(error);
        }
      } finally {
        logging = false;
      }
    },
    { enableHighAccuracy: true, timeout: 10_000 },
  );
}

function handleSearchSelect(result: GeocodeResult): void {
  const { lat, lng, displayName } = result;
  searchPin = { lat, lng, label: displayName };
  const zoom = lastCamera?.zoom;
  target =
    zoom === undefined || zoom < SEARCH_PIN_ZOOM
      ? { lat, lng, zoom: SEARCH_PIN_ZOOM }
      : { lat, lng };
  // The map just flew to the result, so following would drag it back.
  following = false;
}

function handleSearchPinRemove(): void {
  searchPin = null;
}

// The search pin goes so it and the destination don't sit on one spot in the same green.
function routeToSearchPin(pin: SearchPin): void {
  const { lat, lng, label } = pin;
  handleDestSelect({
    placeId: `search:${lat},${lng}`,
    lat,
    lng,
    displayName: label,
    type: INDEX_RESULT_TYPE,
    exact: false,
  });
  searchPin = null;
  searchOpen = false;
  routingWanted = true;
}

function handleSearchDirections(): void {
  if (searchPin) {
    routeToSearchPin(searchPin);
  }
}

function handleToggleRouting(): void {
  if (routingOpen) {
    closeRouting();
  } else if (searchOpen && searchPin !== null) {
    // With a place already found, directions go to it; an empty panel would throw it away.
    routeToSearchPin(searchPin);
  } else {
    searchOpen = false;
    void loadRouting(city.id);
    routingWanted = true;
  }
}

// The search box stays empty so a destination pin doesn't invite a re-search.
function handleSearchOpen(open: boolean): void {
  searchOpen = open;
  if (open) {
    if (dest !== null) {
      searchPin = {
        lat: dest.lat,
        lng: dest.lng,
        label: dest.label ?? "Dropped pin",
      };
    }
    closeRouting();
  }
}

function handlePinSelect(pin: Pin): void {
  editing = { mode: "edit", pin };
  target = { lat: pin.lat, lng: pin.lng, zoom: 16 };
  // Selecting a pin flies away from the user, so release follow rather than fight the watcher.
  following = false;
}

function handleCancel(): void {
  editing = null;
  target = null;
}

async function handleSave(text: string): Promise<void> {
  if (!uid || !editing) {
    return;
  }
  const write =
    editing.mode === "create"
      ? createPin(uid, { ...editing.draft, text })
      : updatePin(uid, editing.pin.id, { text });
  // Optimistic close.
  editing = null;
  target = null;
  try {
    await write;
  } catch {
    banner = "Couldn't save your pin. Check your connection and try again.";
  }
}

async function handleDelete(): Promise<void> {
  if (editing?.mode !== "edit") {
    return;
  }
  const write = deletePin(editing.pin.id);
  editing = null;
  target = null;
  try {
    await write;
  } catch {
    banner = "Couldn't delete your pin. Check your connection and try again.";
  }
}

function handleSignIn(): void {
  signingIn = true;
}

function handleCloseSignIn(): void {
  signingIn = false;
}

async function handleSignOut(): Promise<void> {
  await signOutUser();
  editing = null;
  target = null;
}

async function handleRefreshClaims(): Promise<void> {
  refreshing = true;
  try {
    await refreshClaims();
  } finally {
    refreshing = false;
  }
}

const draft = $derived(editing?.mode === "create" ? editing.draft : null);

// A failed load just omits the POI names.
$effect(() => {
  const cityId = city.id;
  if (!routingOpen || poiSets) {
    return;
  }
  let canceled = false;
  Promise.all([
    loadPois(`landmarks/${cityId}.bin`, "LMRK"),
    loadPois(`art/${cityId}.bin`, "ARTW"),
  ]).then(
    ([landmarks, art]) => {
      if (!canceled) {
        poiSets = { landmarks, art };
      }
    },
    () => {},
  );
  return () => {
    canceled = true;
  };
});

const routeResult = $derived(
  chosen?.result ?? (routeState.kind === "ready" ? routeState.result : null),
);
// The graph the result was computed against, not whichever one state last landed on.
const resultGraph = $derived(
  chosen?.graph ?? (routeState.kind === "ready" ? routeState.graph : null),
);
const directions = $derived.by(() => {
  if (!resultGraph || !routeResult) {
    return null;
  }
  const passed = poiSets
    ? passedPois(resultGraph, routeResult, [
        {
          kind: "landmark",
          set: poiSets.landmarks,
          thresholdMeters: LANDMARK_PASS_METERS,
        },
        { kind: "art", set: poiSets.art, thresholdMeters: ART_PASS_METERS },
      ])
    : [];
  return buildDirections(resultGraph, routeResult, {
    collapseLinearCrossings: true,
    passed,
  });
});
// Null when off-route or unlocated, so the panel falls back to the route summary.
const progress = $derived(
  routeResult && directions && userLocation
    ? navProgress(routeResult, directions, userLocation)
    : null,
);
// Google re-snaps every coordinate, so our sidewalk point can land across the street.
const exportOrigin = $derived(
  manualStart
    ? { lat: manualStart.lat, lng: manualStart.lng }
    : routableLocation
      ? { lat: routableLocation.lat, lng: routableLocation.lng }
      : null,
);

// Planned when a route is drawn, since planning is too slow for the click; held with its route.
let waypointPlan = $state.raw<{
  route: RouteResult;
  plan: WaypointPlan;
} | null>(null);
$effect(() => {
  // Read up front: the plan is of this route, for this city, clock and weights.
  const route = routeResult;
  const request = { cityId: city.id, clock: routeClock, weights };
  // Skipped mid-drag, where the route changes every frame; the drop reruns this.
  if (!route || dragging) {
    return;
  }
  let canceled = false;
  routerClient()
    .waypoints({ ...request, steps: route.steps })
    .then(
      (plan) => {
        if (!canceled && plan) {
          waypointPlan = { route, plan };
        }
      },
      (error: unknown) => {
        console.error("waypoint planning failed:", error);
      },
    );
  return () => {
    canceled = true;
  };
});

// While dragged, the start marker follows the cursor, or it fights Leaflet's drag.
const draggingStart = $derived(dragging && dragWhich === "start");
const askedStart = $derived(
  manualStart
    ? { lat: manualStart.lat, lng: manualStart.lng }
    : routingOpen && routableLocation
      ? { lat: routableLocation.lat, lng: routableLocation.lng }
      : null,
);
const routeStart = $derived(
  shownStart(
    draggingStart ? null : (routeResult?.start.point ?? null),
    routedFrom,
    askedStart,
  ),
);
const routeDest = $derived(dest ? { lat: dest.lat, lng: dest.lng } : null);

// Getters, so a deck reading a field follows it.
const shell: ShellDeck = {
  get city() {
    return city;
  },
  get auth() {
    return auth;
  },
  get pinCount() {
    return pins.length;
  },
  get refreshingClaims() {
    return refreshing;
  },
  onSignIn: handleSignIn,
  onSignOut: handleSignOut,
  onRefreshClaims: handleRefreshClaims,
  onAbout: () => about.set(true),
  onSelectCity: handleSelectCity,
  onLogHere: handleLogHere,
  get logHereDisabled() {
    return userLocation === null;
  },
  get logHereBusy() {
    return logging;
  },
  get logHereHint() {
    return locationHint;
  },
  get settingsSection() {
    return settings.section;
  },
  onSettings: settings.set,
  get syncingAs() {
    return auth.kind === "signedIn" ? auth.info.user.email : null;
  },
  camera,
  get hashApplied() {
    return hashApplied;
  },
  get routingOpen() {
    return routingOpen;
  },
  onToggleRouting: handleToggleRouting,
  get dragging() {
    return dragging;
  },
  get manualStart() {
    return manualStart;
  },
  get dest() {
    return dest;
  },
  get searchPin() {
    return searchPin;
  },
  get destPrefill() {
    return destPrefill;
  },
  get hasLiveLocation() {
    return routableLocation !== null;
  },
  get exportOrigin() {
    return exportOrigin;
  },
  get waypointPlan() {
    return waypointPlan?.route === routeResult ? waypointPlan.plan : null;
  },
  get pickTarget() {
    return pickTarget;
  },
  get routeState() {
    return routeState;
  },
  get graph() {
    return routingGraph;
  },
  get graphAvailable() {
    return graphAvailable;
  },
  get shedFeed() {
    return shedFeed;
  },
  get available() {
    return available;
  },
  get weights() {
    return weights;
  },
  get shadeDataLost() {
    return shadeDataLost;
  },
  get directions() {
    return directions;
  },
  get progress() {
    return progress;
  },
  get directionsOpen() {
    return directionsOpen;
  },
  get minimized() {
    return panelMinimized;
  },
  onToggleDirections: handleToggleDirections,
  onToggleMinimize: handleToggleMinimize,
  onStartSelect: handleStartSelect,
  onDestSelect: handleDestSelect,
  onStartClear: handleClearStart,
  onDestClear: handleClearDest,
  onSwap: handleSwapEndpoints,
  onArmStart: handleArmStart,
  onArmDest: handleArmDest,
  onSearchSelect: handleSearchSelect,
  onSearchClear: handleSearchPinRemove,
  onSearchDirections: handleSearchDirections,
};

// One column under the toolbar, so the keys sit right below the banner whatever its height.
const columnClass = $derived(
  `pointer-events-none absolute inset-x-3 top-16 flex flex-col items-start gap-2 ${
    legends === "top-left-on-phone"
      ? "bottom-[calc(50dvh+0.5rem)] md:bottom-[max(0.75rem,env(safe-area-inset-bottom))]"
      : "bottom-[max(0.75rem,env(safe-area-inset-bottom))]"
  }`,
);
// Scrolls once the column runs out; the padding keeps the cards' shadows unclipped.
const keysClass = $derived(
  `pointer-events-auto relative z-[900] -m-2 min-h-0 max-w-[70vw] space-y-2 overflow-y-auto overscroll-contain p-2 ${
    legends === "top-left" ? "" : "md:z-[1000] md:mt-auto"
  }`,
);
</script>

{#snippet overlayKey(
  Legend: Component | undefined,
)}
  {#if Legend}
    <div><Legend /></div>
  {/if}
{/snippet}

<main class="relative h-dvh w-full overflow-hidden" style={accent}>
  {#await mapView}
    <div
      class="flex h-dvh w-full items-center justify-center text-sm text-slate-400"
    >
      Loading map…
    </div>
  {:then { default: MapView }}
    <MapView
      {city}
      {pins}
      {draft}
      {target}
      {userLocation}
      following={followLive}
      {activeOverlays}
      {routeResult}
      routeGraph={resultGraph}
      routeLines={lines}
      {onSelectLine}
      {onHoverLine}
      {routeDest}
      {routeStart}
      {searchPin}
      onSearchPinDrag={dropSearchPin}
      markerColor={accentHex}
      picking={pickTarget !== null}
      onMapPick={handleMapPick}
      {dragging}
      {initialCamera}
      {preframedDest}
      {routedTo}
      onCamera={handleCamera}
      onBasemapLost={handleBasemapLost}
      onDisengageFollow={handleDisengageFollow}
      onEndpointDragMove={handleEndpointDragMove}
      onEndpointDrag={handleEndpointDrag}
      onPinSelect={handlePinSelect}
    />
  {:catch}
    <!-- The banner says why; nothing can be drawn without the map's code. -->
    <div class="h-dvh w-full"></div>
  {/await}
  {@render controls(shell)}
  <FollowToggle active={followShown} onToggle={handleToggleFollow} />
  <div class={columnClass}>
    <!-- Under the dialogs' 1100, over the map's own chrome. -->
    {#if banner}
      <div
        class="pointer-events-auto relative z-[1050] flex max-w-full shrink-0 items-center gap-3 self-center rounded-2xl bg-slate-900/90 px-4 py-2.5 text-sm font-medium text-white shadow-xl backdrop-blur-md dark:bg-slate-100/95 dark:text-slate-900"
      >
        <span>{banner}</span>
        <button
          type="button"
          onclick={() => (banner = null)}
          aria-label="Dismiss"
          class="grid h-6 w-6 shrink-0 place-items-center rounded-full text-white/70 hover:bg-white/10 hover:text-white dark:text-slate-500 dark:hover:bg-slate-900/10 dark:hover:text-slate-900"
        >
          <Icon icon={FiX} />
        </button>
      </div>
    {/if}
    <div class={keysClass}>
      {#if legend}
        {@render legend({ city, available })}
      {:else}
        <LayerLegend active={activeOverlays} {city} />
      {/if}
      {#each OVERLAYS.filter((overlay) =>
        activeOverlays.has(overlay.id),
      ) as overlay (overlay.id)}
        {@render overlayKey(OVERLAY_VIEWS[overlay.id].legend)}
      {/each}
    </div>
  </div>
  {#if ownSearch}
    <SearchControl
      {city}
      open={searchOpen}
      pinned={searchPin !== null}
      center={mapCenter}
      onOpenChange={handleSearchOpen}
      onSelect={handleSearchSelect}
      onDirections={handleToggleRouting}
      onClear={handleSearchPinRemove}
    />
  {/if}
  {@render panels(shell)}
  {#if editing}
    <PinEditor
      target={editing.mode === "create" ? editing.draft : editing.pin}
      mode={editing.mode}
      onSave={handleSave}
      onDelete={editing.mode === "edit" ? handleDelete : undefined}
      onCancel={handleCancel}
    />
  {/if}
  {#if signingIn}
    <SignInDialog onClose={handleCloseSignIn} />
  {/if}
  {#if about.open}
    <AboutDialog onClose={() => about.set(false)} />
  {/if}
</main>
