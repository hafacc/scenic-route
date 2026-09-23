"use client";

import dynamic from "next/dynamic";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FiX } from "react-icons/fi";
import {
  activeCity,
  CITY_ZOOM,
  type City,
  type CityBounds,
  citiesInView,
  cityById,
  cityInSentence,
  containsPoint,
  DEFAULT_CITY,
  nearestCity,
  setActiveCity,
} from "../src/cities";
import {
  type AuthInfo,
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
import {
  cityFactors,
  type FactorAvailability,
  graphFactors,
} from "../src/modes/modes";
import { OVERLAYS, type OverlayId } from "../src/overlays/registry";
import type { Pin, PinDraft } from "../src/pin";
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
import { buildDirections, type Maneuver } from "../src/routing/directions";
import { endpointCity } from "../src/routing/endpoint-city";
import { loadGraph, type RoutingGraph } from "../src/routing/graph";
import { type NavProgress, navProgress } from "../src/routing/nav-progress";
import { loadPois, type PoiSet, passedPois } from "../src/routing/pois";
import { routerClient } from "../src/routing/router-client";
import type { RouteResult } from "../src/routing/search";
import {
  buildSnapIndex,
  type Snap,
  type SnapIndex,
  snapPair,
} from "../src/routing/snap";
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
  type PlaceUrlState,
  withoutDestQuery,
} from "../src/url-state";
import AboutDialog from "./about-dialog";
import { CityProvider } from "./city-context";
import FollowToggle from "./follow-toggle";
import LayerLegend from "./layer-legend";
import type { DestPrefill } from "./location-field";
import type { MapTarget, SearchPin } from "./map";
import PinEditor from "./pin-editor";
import type { RouteLine } from "./route-layer";
import SearchControl from "./search-control";
import SignInDialog from "./sign-in-dialog";
import { useHashFlag, useHashSection } from "./use-hash-flag";
import { useStandalone } from "./use-install";

// Leaflet touches `window` at module load, so the map must be client-only.
const MapView = dynamic(() => import("./map"), {
  ssr: false,
  loading: () => (
    <div className="flex h-dvh w-full items-center justify-center text-sm text-slate-400">
      Loading map…
    </div>
  ),
});

export type AuthState =
  | { kind: "loading" }
  | { kind: "signedOut" }
  | { kind: "signedIn"; info: AuthInfo };

export type RouteState =
  | { kind: "idle" }
  | { kind: "loading" }
  // Directions index a result's edge numbers into its graph, so the two travel together.
  | { kind: "ready"; result: RouteResult; graph: RoutingGraph }
  | { kind: "error"; message: string };

const RESNAP_METERS = 25;
// Matches the zoom the map's own follow camera uses.
const LOCATED_ZOOM = 16;
// Only ever zoomed in to: someone looking at one block shouldn't be pulled back out.
const SEARCH_PIN_ZOOM = 16;
const LANDMARK_PASS_METERS = 40;
const ART_PASS_METERS = 40;

// Built once per city and shared, so switching back doesn't rebuild an index over 600k edges.
const routingPromises = new Map<
  string,
  Promise<{ graph: RoutingGraph; index: SnapIndex }>
>();
function loadRouting(
  cityId: string,
): Promise<{ graph: RoutingGraph; index: SnapIndex }> {
  const pending = routingPromises.get(cityId);
  if (pending) {
    return pending;
  }
  const request = loadGraph(cityId)
    .then((graph) => {
      // Handed over now, so the worker decodes its copy while this thread builds the snap index.
      void routerClient()
        .load(cityId, graph)
        .catch(() => {}); // the route effect reports it
      return { graph, index: buildSnapIndex(graph) };
    })
    .catch((error: unknown) => {
      routingPromises.delete(cityId);
      throw error;
    });
  routingPromises.set(cityId, request);
  return request;
}

function metersBetween(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = Math.PI / 180;
  const lat1 = a.lat * toRad;
  const lat2 = b.lat * toRad;
  const deltaLat = (b.lat - a.lat) * toRad;
  const deltaLng = (b.lng - a.lng) * toRad;
  const sinLat = Math.sin(deltaLat / 2);
  const sinLng = Math.sin(deltaLng / 2);
  const inner =
    sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(inner)));
}

// Outside the city is its own failure; "300 m from a walkable street" there reads as a map gap.
function messageFor(
  reason: "startTooFar" | "destTooFar" | "disconnected",
  city: City,
  point: LatLng | null,
): string {
  if (reason === "disconnected") {
    return "No walkable connection in the street data — likely separated by water.";
  } else if (point && !containsPoint(city, point)) {
    return `That point is outside ${cityInSentence(city)}, and a route cannot leave it.`;
  } else {
    return "That point is more than 300 m from a walkable street.";
  }
}

type Editing =
  | { mode: "create"; draft: PinDraft }
  | { mode: "edit"; pin: Pin }
  | null;

export interface Endpoint extends LatLng {
  label: string | null;
}

// One hex, mixed in oklab to keep lightness; the percentages are emerald's stops against 600.
function accentVars(hex: string): CSSProperties {
  return {
    "--color-brand-50": `color-mix(in oklab, ${hex} 8%, white)`,
    "--color-brand-100": `color-mix(in oklab, ${hex} 18%, white)`,
    "--color-brand-400": `color-mix(in oklab, ${hex} 62%, white)`,
    "--color-brand-500": `color-mix(in oklab, ${hex} 82%, white)`,
    "--color-brand-600": hex,
    "--color-brand-700": `color-mix(in oklab, ${hex} 82%, black)`,
  } as CSSProperties;
}

export interface ShellDeck {
  city: City;
  auth: AuthState;
  pinCount: number;
  refreshingClaims: boolean;
  onSignIn: () => void;
  onSignOut: () => void | Promise<void>;
  onRefreshClaims: () => void | Promise<void>;
  onAbout: () => void;
  onSelectCity: (city: City) => void;
  onLogHere: () => void;
  logHereDisabled: boolean;
  logHereBusy: boolean;
  logHereHint: string | null;
  // Deep-linked from the hash, so the shell owns it though a deck renders the dialog.
  settingsSection: string | null;
  onSettings: (section: string | null) => void;
  syncingAs: string | null;
  // Read at share time, not passed as a value, so a pan doesn't re-render the deck.
  camera: () => Camera | null;
  hashApplied: boolean;

  routingOpen: boolean;
  onToggleRouting: () => void;
  dragging: boolean;
  manualStart: Endpoint | null;
  dest: Endpoint | null;
  searchPin: SearchPin | null;
  destPrefill: DestPrefill | null;
  hasLiveLocation: boolean;
  // What the reader asked for, not what we snapped it to.
  exportOrigin: LatLng | null;
  // Planned in the worker for the selected route; null until they land, which disables the button.
  waypointPlan: WaypointPlan | null;
  pickTarget: "start" | "dest" | null;
  routeState: RouteState;
  graph: RoutingGraph | null;
  // All false until the graph lands; meanwhile `available` answers from the city's authored list.
  graphAvailable: FactorAvailability;
  // Fetched apart from the graph, so it isn't one of the above.
  shedFeed: boolean;
  available: FactorAvailability;
  weights: RouteWeights;
  shadeDataLost: boolean;
  directions: Maneuver[] | null;
  progress: NavProgress | null;
  directionsOpen: boolean;
  minimized: boolean;
  onToggleDirections: () => void;
  onToggleMinimize: () => void;
  onStartSelect: (result: GeocodeResult) => void;
  onDestSelect: (result: GeocodeResult) => void;
  onStartClear: () => void;
  onDestClear: () => void;
  onSwap: () => void;
  onArmStart: () => void;
  onArmDest: () => void;
  onSearchSelect: (result: GeocodeResult) => void;
  onSearchClear: () => void;
  onSearchDirections: () => void;
}

// Two slots because the shell's chrome sits between them and no z-index sorts it out.
export interface Deck {
  controls: ReactNode;
  panels: ReactNode;
}

// Null means a newer request overtook this one.
export interface SolveRequest {
  city: City;
  clock: RouteClock;
  weights: RouteWeights;
  start: Snap;
  dest: Snap;
  // The graph the endpoints were snapped against, not whichever one state last landed on.
  graph: RoutingGraph;
}

export interface SolveReply {
  result: RouteResult | null;
  changed: boolean;
  // The search runs where the field is, so only its answer knows if the field rebuilt or failed.
  shadeRebuilt?: boolean;
  shadeLost?: boolean;
}

// Functions, not values, since both are shell state a deck would otherwise mirror.
export interface RoutingContext {
  city: City;
  available: FactorAvailability;
}

interface MapShellProps {
  weights: RouteWeights | ((context: RoutingContext) => RouteWeights);
  activeOverlays:
    | ReadonlySet<OverlayId>
    | ((context: RoutingContext) => ReadonlySet<OverlayId>);
  // Called once, so its identity must be stable.
  onLink: (params: URLSearchParams) => PlaceUrlState;
  deck: (shell: ShellDeck) => Deck;
  // Absent asks the worker for one route.
  solve?: (request: SolveRequest) => Promise<SolveReply | null>;
  // Carries its own graph, so the result and graph are always the same city's.
  chosen?: { result: RouteResult; graph: RoutingGraph } | null;
  lines?: readonly RouteLine[];
  onSelectLine?: (index: number) => void;
  onHoverLine?: (index: number | null) => void;
  // Only for a reset the shell makes on its own (leaving the city), not the deck's close button.
  onRoutingReset?: () => void;
  // On a phone Modes' card fills the bottom, so its overlay keys go under the follow button.
  legends?: "bottom-left" | "top-left" | "top-left-on-phone";
  // A deck that puts the box in its own card takes the machinery off `ShellDeck`.
  ownSearch?: boolean;
  alwaysRouting?: boolean;
  // One hex; everything with a `brand` class follows it. Absent keeps the theme's own.
  accent?: string | ((context: RoutingContext) => string);
  // While the deck asks where to go, an armed tap answers its search box.
  tapSearch?: boolean;
  // A deck that plans a set of routes replans only on the drop, since a sweep can't keep up.
  liveDrag?: boolean;
  legend?: (context: RoutingContext) => ReactNode;
  // Absent follows the wall clock; when given, the search reruns only when it changes.
  clock?: RouteClock | null;
}

export default function MapShell({
  weights: weightsProp,
  activeOverlays: overlaysProp,
  onLink,
  deck,
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
}: MapShellProps) {
  const [auth, setAuth] = useState<AuthState>({ kind: "loading" });
  const [pins, setPins] = useState<Pin[]>([]);
  const [editing, setEditing] = useState<Editing>(null);
  const [target, setTarget] = useState<MapTarget | null>(null);
  const [userLocation, setUserLocation] = useState<{
    lat: number;
    lng: number;
  } | null>(null);
  const [logging, setLogging] = useState<boolean>(false);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [following, setFollowing] = useState<boolean>(true);
  // Follows the map center, so panning to another city switches to it.
  const [city, setCity] = useState<City>(DEFAULT_CITY);
  const [signingIn, setSigningIn] = useState<boolean>(false);
  const [aboutOpen, setAboutOpen] = useHashFlag("about");
  const [settingsSection, setSettingsSection] = useHashSection("settings");
  const [locationError, setLocationError] = useState<
    "denied" | "unavailable" | null
  >(null);
  // Bumped to re-register the location watch, or allowing location in Settings waits for relaunch.
  const [locationAttempt, setLocationAttempt] = useState<number>(0);
  const standalone = useStandalone();
  const [banner, setBanner] = useState<string | null>(null);
  // The basemap has no menu row to badge, so it gets the banner.
  const handleBasemapLost = useCallback((lost: boolean) => {
    if (lost) {
      setBanner("Map background unavailable — check your connection.");
    }
  }, []);
  const [routingWanted, setRoutingOpen] = useState<boolean>(false);
  const routingOpen = alwaysRouting || routingWanted;
  // Search and directions share one panel slot: opening either closes the other.
  const [searchOpen, setSearchOpen] = useState<boolean>(false);
  const [manualStart, setManualStart] = useState<{
    lat: number;
    lng: number;
    label: string | null;
  } | null>(null);
  const [dest, setDest] = useState<{
    lat: number;
    lng: number;
    label: string | null;
  } | null>(null);
  const [pickTarget, setPickTarget] = useState<"start" | "dest" | null>(null);
  // Held in state, since the URL is stripped once read and the city can still change.
  const [destQuery, setDestQuery] = useState<string | null>(null);
  const [destPrefill, setDestPrefill] = useState<DestPrefill | null>(null);
  // The sun/shade field is refetched as the clock moves, so it can fail with the graph healthy.
  const [shadeDataLost, setShadeDataLost] = useState<boolean>(false);
  const [routeTimeTick, setRouteTimeTick] = useState<number>(0);
  const [routingGraph, setRoutingGraph] = useState<RoutingGraph | null>(null);
  // Until the graph lands, the city's authored layer list stands in.
  const available: FactorAvailability = useMemo(
    () => (routingGraph ? graphFactors(routingGraph) : cityFactors(city)),
    [routingGraph, city],
  );
  const weights: RouteWeights = useMemo(
    () =>
      typeof weightsProp === "function"
        ? weightsProp({ city, available })
        : weightsProp,
    [weightsProp, city, available],
  );
  const activeOverlays: ReadonlySet<OverlayId> = useMemo(
    () =>
      typeof overlaysProp === "function"
        ? overlaysProp({ city, available })
        : overlaysProp,
    [overlaysProp, city, available],
  );
  const accentHex: string | null = useMemo(() => {
    const hex =
      typeof accentProp === "function"
        ? accentProp({ city, available })
        : accentProp;
    return hex ?? null;
  }, [accentProp, city, available]);
  const accent: CSSProperties | undefined = useMemo(
    () => (accentHex === null ? undefined : accentVars(accentHex)),
    [accentHex],
  );
  const [poiSets, setPoiSets] = useState<{
    landmarks: PoiSet;
    art: PoiSet;
  } | null>(null);
  const [directionsOpen, setDirectionsOpen] = useState<boolean>(false);
  const [panelMinimized, setPanelMinimized] = useState<boolean>(false);
  // Through the resnap threshold, so a followed GPS stream doesn't rerun the search every fix.
  const [resolvedStart, setResolvedStart] = useState<{
    lat: number;
    lng: number;
  } | null>(null);
  const startBasisRef = useRef<{ lat: number; lng: number } | null>(null);
  const [routeState, setRouteState] = useState<RouteState>({ kind: "idle" });
  // Last-routed endpoints, so a slider move recomputes without a loading flash.
  const routedForRef = useRef<{
    start: { lat: number; lng: number };
    dest: { lat: number; lng: number };
  } | null>(null);
  // For the maneuver list (ferry timetable) and the Google Maps export; the worker has its own.
  const contextsRef = useRef<RouteContexts | null>(null);
  contextsRef.current ??= new RouteContexts();
  // Holds the drawn route during a drag instead of flashing a loading state each frame.
  const draggingRef = useRef<boolean>(false);
  const dragWhichRef = useRef<"start" | "dest">("dest");
  const [dragging, setDragging] = useState<boolean>(false);
  // Bumped on drop to rerun the exact recompute, since a start drop leaves the endpoints unchanged.
  const [routeRefreshNonce, setRouteRefreshNonce] = useState<number>(0);
  // Lets a recompute apply an unchanged cached result when nothing is drawn yet.
  const hasReadyRouteRef = useRef<boolean>(false);
  // A start-drag solves backward and anchors the sun at this arrival time.
  const lastTravelSecondsRef = useRef<number | null>(null);
  // Tells a drop (lands silently) from a fresh target (shows the loading spinner).
  const lastAppliedNonceRef = useRef<number>(0);
  // Mirrored into a ref for the camera callback, which must keep its identity.
  const [hashApplied, setHashApplied] = useState<boolean>(false);
  const hashAppliedRef = useRef<boolean>(false);
  // A stored city doesn't count: the live position is a better answer.
  const linkedCityRef = useRef<boolean>(false);
  // Lets a switch tell a route it has outlived from one that arrived with the city.
  const endpointCityRef = useRef<string | null>(null);
  // Only the first location fix decides the city.
  const coverageChecked = useRef<boolean>(false);
  // Applied once by the map; null lets a fresh route frame itself.
  const [initialCamera, setInitialCamera] = useState<Camera | null>(null);
  const [preframedDest, setPreframedDest] = useState<LatLng | null>(null);
  // Outlives the panel closing; a second search replaces it.
  const [searchPin, setSearchPin] = useState<SearchPin | null>(null);
  // Tracked in a ref so a pan doesn't re-render.
  const cameraRef = useRef<Camera | null>(null);
  // Through a ref, since a planning deck rebuilds this with every plan and would search again.
  const solveRef = useRef<MapShellProps["solve"]>(solve);
  solveRef.current = solve;
  // Through a ref too, so a new handler identity doesn't rerun the city effect.
  const routingResetRef =
    useRef<MapShellProps["onRoutingReset"]>(onRoutingReset);
  routingResetRef.current = onRoutingReset;

  // A hand-armed start still sets the start.
  const tapFindsPlace =
    tapSearch && pickTarget === "dest" && dest === null && destPrefill === null;

  // Read out one by one, since the deck passes a fresh weights object on every move.
  const {
    shade: shadeWeight,
    shelter: shelterWeight,
    allowSheds,
    allowFerries,
    allowTransit,
  } = weights;
  // Each tick re-costs against the sun and the next sailing; a new day restands the scaffolding.
  useEffect(() => {
    const follows = followsRouteTime({
      shade: shadeWeight,
      shelter: shelterWeight,
      allowSheds,
      allowFerries,
      allowTransit,
    });
    if (!follows) {
      return;
    }
    return subscribeRouteTime(() => setRouteTimeTick((tick) => tick + 1));
  }, [shadeWeight, shelterWeight, allowSheds, allowFerries, allowTransit]);

  // An offline note waits in Firestore's cache until something builds the Firestore instance.
  useEffect(() => {
    flushPendingFeedback().catch(() => {});
  }, []);

  useEffect(() => {
    const unsubscribe = watchAuth((info) => {
      // onIdTokenChanged re-fires each refresh; keep the old ref when uid and admin match.
      setAuth((prev) => {
        if (!info) {
          return prev.kind === "signedOut" ? prev : { kind: "signedOut" };
        }
        if (
          prev.kind === "signedIn" &&
          prev.info.user.uid === info.user.uid &&
          prev.info.admin === info.admin
        ) {
          return prev;
        }
        return { kind: "signedIn", info };
      });
    });
    return unsubscribe;
  }, []);

  // Keyed on the uid, not the auth object, which is replaced on every token refresh.
  const syncingUid = auth.kind === "signedIn" ? auth.info.user.uid : null;
  useEffect(() => {
    if (syncingUid === null) {
      stopSettingsSync();
      return undefined;
    } else {
      startSettingsSync(syncingUid);
      return stopSettingsSync;
    }
  }, [syncingUid]);

  // iOS copies cookies from Safari only at install, so the installed app has its own permissions.
  const locationHint =
    locationError === "denied"
      ? standalone
        ? "Location is blocked for this app — allow it in iOS Settings › Privacy & Security › Location Services › Scenic Route, then tap the location button. If Scenic Route is not listed, remove it from the Home Screen and add it again."
        : "Location access is blocked — enable it in your browser settings."
      : locationError === "unavailable"
        ? "Couldn't get your location. Make sure location services are on."
        : null;

  useEffect(() => {
    if (locationHint) {
      setBanner(locationHint);
    }
  }, [locationHint]);

  const uid = auth.kind === "signedIn" ? auth.info.user.uid : null;
  const isAdmin = auth.kind === "signedIn" && auth.info.admin;

  useEffect(() => {
    if (!isAdmin) {
      setPins([]);
      return;
    }
    const unsubscribe = watchPins(setPins, () => {
      setBanner("Live updates stopped. Reload the page to reconnect.");
    });
    return unsubscribe;
  }, [isAdmin]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the attempt count re-issues the watch
  useEffect(() => {
    if (!("geolocation" in navigator)) {
      return;
    }
    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        setUserLocation({ lat, lng });
        setLocationError(null);
        // Only the first fix picks the city, and only if the link named none; else the nearest.
        if (!coverageChecked.current) {
          coverageChecked.current = true;
          const nearest = nearestCity({ lat, lng });
          if (!containsPoint(nearest, { lat, lng })) {
            setFollowing(false);
            setCity(nearest);
            setTarget({ ...nearest.center, zoom: CITY_ZOOM });
          } else if (!linkedCityRef.current) {
            // The camera moves with the city, or it reports the old city back and undoes this.
            // Never set alongside a link's initial camera in one commit.
            setCity(nearest);
            setTarget({ lat, lng, zoom: LOCATED_ZOOM });
          }
        }
      },
      (error) => {
        setLocationError(
          error.code === error.PERMISSION_DENIED ? "denied" : "unavailable",
        );
      },
      { enableHighAccuracy: false, maximumAge: 30_000 },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [locationAttempt]);

  // A fix outside the active city is not a start, a center, or a "My location".
  const routableLocation =
    userLocation && containsPoint(city, userLocation) ? userLocation : null;

  // Derived, since the map's follow effect would fly the camera before any effect here fires.
  const followLive =
    following && (userLocation === null || routableLocation !== null);

  // Clears everything but the slider values. Declared above the city effect that uses it.
  const closeRouting = useCallback(() => {
    setDest(null);
    setManualStart(null);
    setPickTarget(null);
    setRouteState({ kind: "idle" });
    routedForRef.current = null;
    // The peek bar means nothing over an empty panel.
    setPanelMinimized(false);
    setRoutingOpen(false);
  }, []);

  // Only leaving the endpoints' recorded city clears them. Ordered before the search effect.
  useEffect(() => {
    const { recorded, left } = endpointCity(
      endpointCityRef.current,
      city.id,
      dest !== null || manualStart !== null,
    );
    endpointCityRef.current = recorded;
    if (left) {
      closeRouting();
      routerClient().reset();
      routingResetRef.current?.();
    }
  }, [city, dest, manualStart, closeRouting]);

  // Its own ref, since a link's city lands in the same commit as its pin.
  const pinCityRef = useRef<string | null>(null);
  useEffect(() => {
    const { recorded, left } = endpointCity(
      pinCityRef.current,
      city.id,
      searchPin !== null,
    );
    pinCityRef.current = recorded;
    if (left) {
      setSearchPin(null);
    }
  }, [city, searchPin]);

  // Clearing the error first lets a second refusal re-raise a dismissed banner.
  const retryLocation = useCallback(() => {
    if (userLocation === null) {
      setLocationError(null);
      setLocationAttempt((attempt) => attempt + 1);
    }
  }, [userLocation]);

  // Engaging from outside the active city moves the city with the camera.
  const handleToggleFollow = useCallback(() => {
    if (followLive) {
      setFollowing(false);
    } else {
      setFollowing(true);
      if (userLocation === null) {
        retryLocation();
      } else if (!routableLocation) {
        setCity(nearestCity(userLocation));
      }
    }
  }, [followLive, userLocation, routableLocation, retryLocation]);

  const handleSelectCity = useCallback((picked: City) => {
    setFollowing(false);
    setCity(picked);
    setTarget({ ...picked.center, zoom: CITY_ZOOM });
  }, []);

  // Assigned during render, since the layers read it in their own effects, which run first.
  setActiveCity(city);

  useEffect(() => {
    setPoiSets(null);
    // Null until this city's graph lands, or sliders stay lit for data the new city lacks.
    setRoutingGraph(null);
    // Prefetched on idle so offline search works: ten megabytes against the graph's thirty-nine.
    const prefetch = () => {
      void prefetchNameIndex(city.id);
    };
    if (typeof requestIdleCallback === "function") {
      const handle = requestIdleCallback(prefetch, { timeout: 5000 });
      return () => cancelIdleCallback(handle);
    } else {
      const handle = window.setTimeout(prefetch, 2000);
      return () => window.clearTimeout(handle);
    }
  }, [city]);

  // The decoded index is 40 MB, so it is held only while a panel is open, or iOS kills the session.
  useEffect(() => {
    if (routingOpen || searchOpen) {
      warmNameIndex(city.id);
    } else {
      releaseNameIndex();
    }
  }, [routingOpen, searchOpen, city]);

  // Stable identity for a long-lived map listener.
  const handleDisengageFollow = useCallback(() => {
    setFollowing(() => false);
  }, []);

  // The live location is chased only past the resnap threshold, so GPS doesn't churn the search.
  useEffect(() => {
    if (manualStart) {
      startBasisRef.current = null;
      setResolvedStart((previous) =>
        previous &&
        previous.lat === manualStart.lat &&
        previous.lng === manualStart.lng
          ? previous
          : { lat: manualStart.lat, lng: manualStart.lng },
      );
    } else if (!routableLocation) {
      // A fix outside the active city is not a start; adopting it guarantees a failed search.
      startBasisRef.current = null;
      setResolvedStart(null);
    } else {
      const basis = startBasisRef.current;
      if (!basis || metersBetween(basis, routableLocation) > RESNAP_METERS) {
        startBasisRef.current = {
          lat: routableLocation.lat,
          lng: routableLocation.lng,
        };
        setResolvedStart({
          lat: routableLocation.lat,
          lng: routableLocation.lng,
        });
      }
    }
  }, [manualStart, routableLocation]);

  useEffect(() => {
    hasReadyRouteRef.current = routeState.kind === "ready";
    lastTravelSecondsRef.current =
      routeState.kind === "ready" ? routeState.result.travelSeconds : null;
  }, [routeState]);

  // Captured, since the `activeCity()` global can move while a graph fetch is in flight.
  const routeCity = city;

  // The page and worker share one departure instant, so they catch the same boat.
  const liveClock = useMemo<RouteClock>(
    () => ({ tick: routeTimeTick, dateMs: getResolvedDate().getTime() }),
    [routeTimeTick],
  );
  const routeClock = clockProp ?? liveClock;

  // All false until the graph lands.
  const graphAvailable: FactorAvailability = useMemo(
    () => graphFactors(routingGraph),
    [routingGraph],
  );
  // Sheds are fetched apart from the graph, so the scaffolding gate asks the city's overlay list.
  const shedFeed = city.overlays.includes("scaffolding");

  // rAF-coalesced, so a slider drag computes at most once per frame.
  useEffect(() => {
    if (!resolvedStart || !dest) {
      setRouteState({ kind: "idle" });
      routedForRef.current = null;
      return;
    }
    const request = {
      start: { lat: resolvedStart.lat, lng: resolvedStart.lng },
      dest: { lat: dest.lat, lng: dest.lng },
    };
    // A deck that replans on the drop holds the plan on screen while the marker moves.
    if (draggingRef.current && !liveDrag) {
      return;
    }
    const previous = routedForRef.current;
    const isNewTarget =
      !previous ||
      previous.dest.lat !== request.dest.lat ||
      previous.dest.lng !== request.dest.lng ||
      previous.start.lat !== request.start.lat ||
      previous.start.lng !== request.start.lng;
    let canceled = false;
    const frame = requestAnimationFrame(() => {
      // A drop's recompute lands silently so the drawn route holds until the exact one is ready.
      const isDropRefresh = routeRefreshNonce !== lastAppliedNonceRef.current;
      lastAppliedNonceRef.current = routeRefreshNonce;
      if (isNewTarget && !draggingRef.current && !isDropRefresh) {
        setRouteState({ kind: "loading" });
      }
      loadRouting(routeCity.id)
        .then(
          async ({ graph, index }) => {
            if (canceled) {
              return;
            }
            // `loadRouting` returns one stable graph per city, so never keep the first one.
            setRoutingGraph((current) => (current === graph ? current : graph));
            routedForRef.current = request;
            const client = routerClient();
            // Awaited so a graph the worker can't decode reaches the panel as an error.
            await client.load(routeCity.id, graph);
            if (canceled) {
              return;
            }
            const contexts = (contextsRef.current ??= new RouteContexts());
            // The timetable alone; the worker builds every costed field on its own copy.
            await contexts.syncFerries(graph, routeCity, routeClock, weights);
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
              setRouteState({
                kind: "error",
                message: messageFor(pair.reason, routeCity, offending),
              });
              return;
            }
            const which = dragWhichRef.current;
            // Mid-drag the worker reuses a per-gesture solver for an approximate route.
            const solveOne = solveRef.current;
            // The deck's own solver runs on this thread; the worker gets only the endpoints.
            let reply: SolveReply | null;
            if (draggingRef.current) {
              reply = await client.dragMove({
                cityId: routeCity.id,
                clock: routeClock,
                weights,
                anchor: which === "dest" ? pair.start : pair.dest,
                moving: which === "dest" ? pair.dest : pair.start,
                anchorSeconds: lastTravelSecondsRef.current ?? 0,
              });
            } else if (solveOne) {
              reply = await solveOne({
                city: routeCity,
                clock: routeClock,
                weights,
                start: pair.start,
                dest: pair.dest,
                graph,
              });
            } else {
              reply = await client.route({
                cityId: routeCity.id,
                clock: routeClock,
                weights,
                start: pair.start,
                dest: pair.dest,
              });
            }
            // Null means a newer frame overtook this one in the worker.
            if (canceled || !reply) {
              return;
            }
            // Only on a rebuild, or a slow failure after a success grays out a working slider.
            if (reply.shadeRebuilt) {
              setShadeDataLost(reply.shadeLost ?? false);
            }
            // Always apply when nothing is drawn, or the loading state would strand.
            if (reply.changed || !hasReadyRouteRef.current) {
              if (reply.result) {
                setRouteState({ kind: "ready", result: reply.result, graph });
              } else {
                setRouteState({
                  kind: "error",
                  message: messageFor("disconnected", routeCity, null),
                });
              }
            }
          },
          () => {
            if (!canceled) {
              setRouteState({
                kind: "error",
                message:
                  "Couldn't load the routing data. Check your connection.",
              });
            }
          },
        )
        .catch((error: unknown) => {
          // A worker refusal isn't a network failure, but the panel has one way to say so.
          console.error("routing failed:", error);
          if (!canceled) {
            setRouteState({
              kind: "error",
              message: "Couldn't load the routing data. Check your connection.",
            });
          }
        });
    });
    return () => {
      canceled = true;
      cancelAnimationFrame(frame);
    };
  }, [
    resolvedStart,
    dest,
    weights,
    routeClock,
    routeRefreshNonce,
    routeCity,
    liveDrag,
  ]);

  // Keyed on the coordinates so a reverse-geocode label patch doesn't snap it shut.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on the point, not its identity
  useEffect(() => {
    setDirectionsOpen(false);
  }, [dest?.lat, dest?.lng]);

  const handleToggleDirections = useCallback(() => {
    setDirectionsOpen((open) => !open);
  }, []);

  const handleToggleMinimize = useCallback(() => {
    setPanelMinimized((on) => !on);
  }, []);

  // Retires any link query, so a lookup still running can't overwrite the reader's answer.
  const forgetDestQuery = useCallback(() => {
    setDestQuery(null);
    setDestPrefill(null);
  }, []);

  const handleDestSelect = useCallback(
    (result: GeocodeResult) => {
      setDest({ lat: result.lat, lng: result.lng, label: result.displayName });
      setPickTarget(null);
      forgetDestQuery();
    },
    [forgetDestQuery],
  );

  const handleStartSelect = useCallback((result: GeocodeResult) => {
    setManualStart({
      lat: result.lat,
      lng: result.lng,
      label: result.displayName,
    });
    setPickTarget(null);
  }, []);

  const handleClearDest = useCallback(() => {
    setDest(null);
    setPickTarget((target) => (target === "dest" ? null : target));
    forgetDestQuery();
  }, [forgetDestQuery]);

  // Clearing the start routes from the live fix, so it asks for one when there is none.
  const handleClearStart = useCallback(() => {
    setManualStart(null);
    setPickTarget((target) => (target === "start" ? null : target));
    retryLocation();
  }, [retryLocation]);

  // Costs are directional (hills, ferries, sun), so the way back is a new search.
  const handleSwapEndpoints = useCallback(() => {
    setManualStart(dest);
    setDest(manualStart);
    setPickTarget(null);
    forgetDestQuery();
  }, [dest, manualStart, forgetDestQuery]);

  const handleArmStart = useCallback(() => {
    setPickTarget((target) => (target === "start" ? null : "start"));
  }, []);

  const handleArmDest = useCallback(() => {
    setPickTarget((target) => (target === "dest" ? null : "dest"));
  }, []);

  const applyPick = useCallback(
    (target: "start" | "dest", lat: number, lng: number) => {
      // Immediate feedback; the reverse geocode replaces it.
      const pinned = { lat, lng, label: "Dropped pin" };
      if (target === "start") {
        setManualStart(pinned);
      } else {
        setDest(pinned);
        forgetDestQuery();
      }
      reverseGeocode(lat, lng)
        .then((place) => {
          if (!place) {
            return;
          }
          const patch = (
            current: { lat: number; lng: number; label: string | null } | null,
          ) =>
            current && current.lat === lat && current.lng === lng
              ? { ...current, label: place.displayName }
              : current;
          if (target === "start") {
            setManualStart(patch);
          } else {
            setDest(patch);
          }
        })
        .catch(() => {});
    },
    [forgetDestQuery],
  );

  const dropSearchPin = useCallback((lat: number, lng: number) => {
    setSearchPin({ lat, lng, label: "Dropped pin" });
    reverseGeocode(lat, lng)
      .then((place) => {
        if (place) {
          setSearchPin((pin) =>
            pin && pin.lat === lat && pin.lng === lng
              ? { ...pin, label: place.displayName }
              : pin,
          );
        }
      })
      .catch(() => {});
  }, []);

  // A live start that ends a route is pinned, or it would move as you walk and share as nothing.
  useEffect(() => {
    if (!dest || manualStart || !routableLocation) {
      return;
    }
    applyPick("start", routableLocation.lat, routableLocation.lng);
  }, [dest, manualStart, routableLocation, applyPick]);

  // Keeps the prior label until the drag settles, rather than reverse geocoding per frame.
  const handleEndpointDragMove = useCallback(
    (which: "start" | "dest", lat: number, lng: number) => {
      if (!draggingRef.current && liveDrag) {
        routerClient().dragStart(which);
      }
      draggingRef.current = true;
      dragWhichRef.current = which;
      setDragging(true);
      handleDisengageFollow();
      if (which === "start") {
        setManualStart((previous) => ({
          lat,
          lng,
          label: previous?.label ?? null,
        }));
      } else {
        setDest((previous) => ({ lat, lng, label: previous?.label ?? null }));
      }
    },
    [handleDisengageFollow, liveDrag],
  );

  // The drag bypassed the route cache, whose stale baseline would call the exact route unchanged.
  const handleEndpointDrag = useCallback(
    (which: "start" | "dest", lat: number, lng: number) => {
      draggingRef.current = false;
      setDragging(false);
      handleDisengageFollow();
      applyPick(which, lat, lng);
      const client = routerClient();
      if (liveDrag) {
        client.dragEnd();
      }
      client.reset();
      setRouteRefreshNonce((nonce) => nonce + 1);
    },
    [applyPick, handleDisengageFollow, liveDrag],
  );

  // A link's keys win over stored values; the hash writer is enabled only after.
  useEffect(() => {
    const params = hashParams(window.location.hash);
    const route = onLink(params);
    if (route.customHour !== null) {
      setCustomHour(route.customHour);
    }
    if (route.customDay !== null) {
      setCustomDay(route.customDay);
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
      setRoutingOpen(true);
      // A link naming a route wins over the first location fix, even in the same city.
      setFollowing(false);
      void loadRouting(activeCity().id);
    }
    const view = decodeView(params);
    // The city comes from the link, then the live fix, then the default; never the last one viewed.
    const linked =
      cityById(view.city) ??
      (route.dest ? nearestCity(route.dest) : null) ??
      (route.pin ? nearestCity(route.pin) : null);
    linkedCityRef.current = linked !== null;
    if (linked) {
      setCity(linked);
    }
    if (view.camera) {
      setInitialCamera(view.camera);
      setPreframedDest(route.dest);
      setFollowing(false);
    } else if (route.pin) {
      // A pin has no route bounds, so the link frames the pin itself.
      setInitialCamera({ center: route.pin, zoom: SEARCH_PIN_ZOOM });
      setFollowing(false);
    } else if (linked) {
      // Framed before the map settles, since the camera decides the active city.
      setInitialCamera({ center: linked.center, zoom: CITY_ZOOM });
    }
    hashAppliedRef.current = true;
    setHashApplied(true);
  }, [applyPick, dropSearchPin, onLink]);

  // Read once and stripped from the URL so a link can't fire twice or be passed on.
  useEffect(() => {
    if (!hashApplied || destQuery !== null) {
      return;
    }
    const asked =
      decodeDestQuery(hashParams(window.location.hash)) ??
      sharedDestinationText(new URLSearchParams(window.location.search));
    if (asked === null) {
      return;
    }
    setRoutingOpen(true);
    setDestQuery(asked);
    setDestPrefill({ text: asked, results: [] });
    window.history.replaceState(
      null,
      "",
      window.location.pathname +
        withoutShareParams(window.location.search) +
        withoutDestQuery(window.location.hash),
    );
  }, [hashApplied, destQuery]);

  // Only an exact house number is routed to, since silently routing to one of eleven is worse.
  useEffect(() => {
    if (destQuery === null) {
      return;
    }
    let canceled = false;
    const cityId = city.id;
    // Waits for the index: a cold link would otherwise answer "nothing found" for a real address.
    awaitNameIndex(cityId)
      .then(() =>
        resolveSharedQuery(destQuery, cityId, searchAddress, () => canceled),
      )
      .then((found) => {
        if (canceled || found === null) {
          return;
        }
        setDestQuery(null);
        if (found.exact === null) {
          setDestPrefill({ text: found.query, results: found.results });
        } else {
          const { lat, lng, displayName } = found.exact;
          setDest({ lat, lng, label: displayName });
          setDestPrefill(null);
        }
      });
    return () => {
      canceled = true;
    };
  }, [destQuery, city]);

  const handleCamera = useCallback((camera: Camera, view: CityBounds) => {
    cameraRef.current = camera;
    // The first report comes from the container's default center, before the link is read.
    if (!hashAppliedRef.current) {
      return;
    }
    // Proposed through the updater: a settled camera reports several times per tick.
    const inView = citiesInView(view);
    if (inView.length === 1) {
      const [next] = inView;
      // The address search ranks same-named streets by distance from it.
      setSearchCenter(next.id, camera.center);
      setCity((current) => (next.id === current.id ? current : next));
    }
  }, []);

  // A function, since the camera lives in a ref and a pan must not re-render the app.
  const mapCenter = useCallback(() => cameraRef.current?.center ?? null, []);

  const camera = useCallback((): Camera | null => cameraRef.current, []);

  // A tap places nothing unless a field is armed.
  const handleMapPick = useCallback(
    (lat: number, lng: number) => {
      if (pickTarget === null) {
        return;
      } else if (tapFindsPlace) {
        // The same answer a suggestion gives, so a tap never opens directions on its own.
        dropSearchPin(lat, lng);
        setPickTarget(null);
      } else {
        applyPick(pickTarget, lat, lng);
        setPickTarget(null);
      }
    },
    [pickTarget, tapFindsPlace, dropSearchPin, applyPick],
  );

  const handleLogHere = useCallback(async () => {
    const openEditorAt = async (lat: number, lng: number) => {
      let address = "Unknown location";
      try {
        const result = await reverseGeocode(lat, lng);
        if (result) {
          address = result.displayName;
        }
      } catch {}
      setEditing({ mode: "create", draft: { lat, lng, address, text: "" } });
    };
    if (!("geolocation" in navigator)) {
      return;
    }
    setLogging(true);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          await openEditorAt(
            position.coords.latitude,
            position.coords.longitude,
          );
        } finally {
          setLogging(false);
        }
      },
      async (error) => {
        try {
          // High-accuracy fix failed; fall back to the last watched position.
          if (userLocation) {
            await openEditorAt(userLocation.lat, userLocation.lng);
          } else {
            setLocationError(
              error.code === error.PERMISSION_DENIED ? "denied" : "unavailable",
            );
          }
        } finally {
          setLogging(false);
        }
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }, [userLocation]);

  const handleSearchSelect = useCallback((result: GeocodeResult) => {
    const { lat, lng, displayName } = result;
    setSearchPin({ lat, lng, label: displayName });
    const zoom = cameraRef.current?.zoom;
    setTarget(
      zoom === undefined || zoom < SEARCH_PIN_ZOOM
        ? { lat, lng, zoom: SEARCH_PIN_ZOOM }
        : { lat, lng },
    );
    // The map just flew to the result, so following would drag it back.
    setFollowing(false);
  }, []);

  const handleSearchPinRemove = useCallback(() => {
    setSearchPin(null);
  }, []);

  // The search pin goes so it and the destination don't sit on one spot in the same green.
  const routeToSearchPin = useCallback(
    (pin: SearchPin) => {
      const { lat, lng, label } = pin;
      handleDestSelect({
        placeId: `search:${lat},${lng}`,
        lat,
        lng,
        displayName: label,
        type: INDEX_RESULT_TYPE,
        exact: false,
      });
      setSearchPin(null);
      setSearchOpen(false);
      setRoutingOpen(true);
    },
    [handleDestSelect],
  );

  const handleSearchDirections = useCallback(() => {
    if (searchPin) {
      routeToSearchPin(searchPin);
    }
  }, [searchPin, routeToSearchPin]);

  // Reads current values, since updaters must be pure and React calls them twice in development.
  const handleToggleRouting = useCallback(() => {
    if (routingOpen) {
      closeRouting();
    } else if (searchOpen && searchPin !== null) {
      // With a place already found, directions go to it; an empty panel would throw it away.
      routeToSearchPin(searchPin);
    } else {
      setSearchOpen(false);
      void loadRouting(city.id);
      setRoutingOpen(true);
    }
  }, [
    routingOpen,
    searchOpen,
    searchPin,
    closeRouting,
    routeToSearchPin,
    city.id,
  ]);

  // The search box stays empty so a destination pin doesn't invite a re-search.
  const handleSearchOpen = useCallback(
    (open: boolean) => {
      setSearchOpen(open);
      if (open) {
        if (dest !== null) {
          setSearchPin({
            lat: dest.lat,
            lng: dest.lng,
            label: dest.label ?? "Dropped pin",
          });
        }
        closeRouting();
      }
    },
    [closeRouting, dest],
  );

  const handlePinSelect = useCallback((pin: Pin) => {
    setEditing({ mode: "edit", pin });
    setTarget({ lat: pin.lat, lng: pin.lng, zoom: 16 });
    // Selecting a pin flies away from the user, so release follow rather than fight the watcher.
    setFollowing(false);
  }, []);

  const handleCancel = useCallback(() => {
    setEditing(null);
    setTarget(null);
  }, []);

  const handleSave = useCallback(
    async (text: string) => {
      if (!uid || !editing) {
        return;
      }
      const write =
        editing.mode === "create"
          ? createPin(uid, { ...editing.draft, text })
          : updatePin(uid, editing.pin.id, { text });
      // Optimistic close.
      setEditing(null);
      setTarget(null);
      try {
        await write;
      } catch {
        setBanner(
          "Couldn't save your pin. Check your connection and try again.",
        );
      }
    },
    [uid, editing],
  );

  const handleDelete = useCallback(async () => {
    if (editing?.mode !== "edit") {
      return;
    }
    const write = deletePin(editing.pin.id);
    setEditing(null);
    setTarget(null);
    try {
      await write;
    } catch {
      setBanner(
        "Couldn't delete your pin. Check your connection and try again.",
      );
    }
  }, [editing]);

  const handleSignIn = useCallback(() => {
    setSigningIn(true);
  }, []);

  const handleCloseSignIn = useCallback(() => {
    setSigningIn(false);
  }, []);

  const handleSignOut = useCallback(async () => {
    await signOutUser();
    setEditing(null);
    setTarget(null);
  }, []);

  const handleRefreshClaims = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshClaims();
    } finally {
      setRefreshing(false);
    }
  }, []);

  const draft = editing?.mode === "create" ? editing.draft : null;

  // A failed load just omits the POI names.
  useEffect(() => {
    if (!routingOpen || poiSets) {
      return;
    }
    let canceled = false;
    Promise.all([
      loadPois(`landmarks/${city.id}.bin`, "LMRK"),
      loadPois(`art/${city.id}.bin`, "ARTW"),
    ]).then(
      ([landmarks, art]) => {
        if (!canceled) {
          setPoiSets({ landmarks, art });
        }
      },
      () => {},
    );
    return () => {
      canceled = true;
    };
  }, [routingOpen, poiSets, city.id]);

  const routeResult =
    chosen?.result ?? (routeState.kind === "ready" ? routeState.result : null);
  // The graph the result was computed against, not whichever one state last landed on.
  const resultGraph =
    chosen?.graph ?? (routeState.kind === "ready" ? routeState.graph : null);
  const directions = useMemo(() => {
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
  }, [resultGraph, routeResult, poiSets]);
  // Null when off-route or unlocated, so the panel falls back to the route summary.
  const progress = useMemo(
    () =>
      routeResult && directions && userLocation
        ? navProgress(routeResult, directions, userLocation)
        : null,
    [routeResult, directions, userLocation],
  );
  // Google re-snaps every coordinate, so our sidewalk point can land across the street.
  const exportOrigin = manualStart
    ? { lat: manualStart.lat, lng: manualStart.lng }
    : routableLocation
      ? { lat: routableLocation.lat, lng: routableLocation.lng }
      : null;

  // Planned when a route is drawn, since planning is too slow for the click; held with its route.
  const [waypointPlan, setWaypointPlan] = useState<{
    route: RouteResult;
    plan: WaypointPlan;
  } | null>(null);
  useEffect(() => {
    // Skipped mid-drag, where the route changes every frame; the drop reruns this.
    if (!routeResult || dragging) {
      return;
    }
    let canceled = false;
    routerClient()
      .waypoints({
        cityId: routeCity.id,
        clock: routeClock,
        weights,
        steps: routeResult.steps,
      })
      .then(
        (plan) => {
          if (!canceled && plan) {
            setWaypointPlan({ route: routeResult, plan });
          }
        },
        (error: unknown) => {
          console.error("waypoint planning failed:", error);
        },
      );
    return () => {
      canceled = true;
    };
  }, [routeResult, dragging, routeCity, routeClock, weights]);

  // While dragged, the start marker follows the cursor, or it fights Leaflet's drag.
  const draggingStart = dragging && dragWhichRef.current === "start";
  const routeStart =
    !draggingStart && routeResult
      ? routeResult.start.point
      : manualStart
        ? { lat: manualStart.lat, lng: manualStart.lng }
        : routingOpen && routableLocation
          ? { lat: routableLocation.lat, lng: routableLocation.lng }
          : null;
  const routeDest = dest ? { lat: dest.lat, lng: dest.lng } : null;

  const shell: ShellDeck = {
    city,
    auth,
    pinCount: pins.length,
    refreshingClaims: refreshing,
    onSignIn: handleSignIn,
    onSignOut: handleSignOut,
    onRefreshClaims: handleRefreshClaims,
    onAbout: () => setAboutOpen(true),
    onSelectCity: handleSelectCity,
    onLogHere: handleLogHere,
    logHereDisabled: userLocation === null,
    logHereBusy: logging,
    logHereHint: locationHint,
    settingsSection,
    onSettings: setSettingsSection,
    syncingAs: auth.kind === "signedIn" ? auth.info.user.email : null,
    camera,
    hashApplied,
    routingOpen,
    onToggleRouting: handleToggleRouting,
    dragging,
    manualStart,
    dest,
    searchPin,
    destPrefill,
    hasLiveLocation: routableLocation !== null,
    exportOrigin,
    waypointPlan:
      waypointPlan?.route === routeResult ? waypointPlan.plan : null,
    pickTarget,
    routeState,
    graph: routingGraph,
    graphAvailable,
    shedFeed,
    available,
    weights,
    shadeDataLost,
    directions,
    progress,
    directionsOpen,
    minimized: panelMinimized,
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

  const { controls, panels } = deck(shell);

  return (
    <CityProvider value={city}>
      <main className="relative h-dvh w-full overflow-hidden" style={accent}>
        <MapView
          city={city}
          pins={pins}
          draft={draft}
          target={target}
          userLocation={userLocation}
          following={followLive}
          activeOverlays={activeOverlays}
          routeResult={routeResult}
          routeGraph={resultGraph}
          routeLines={lines}
          onSelectLine={onSelectLine}
          onHoverLine={onHoverLine}
          routeDest={routeDest}
          routeStart={routeStart}
          searchPin={searchPin}
          onSearchPinDrag={dropSearchPin}
          markerColor={accentHex}
          picking={pickTarget !== null}
          onMapPick={handleMapPick}
          dragging={dragging}
          initialCamera={initialCamera}
          preframedDest={preframedDest}
          onCamera={handleCamera}
          onBasemapLost={handleBasemapLost}
          onDisengageFollow={handleDisengageFollow}
          onEndpointDragMove={handleEndpointDragMove}
          onEndpointDrag={handleEndpointDrag}
          onPinSelect={handlePinSelect}
        />
        {controls}
        <FollowToggle active={followLive} onToggle={handleToggleFollow} />
        {/* Modes puts the keys top-left on a phone, where its card fills the bottom. */}
        <div
          className={`pointer-events-none absolute max-w-[70vw] ${
            legends === "bottom-left"
              ? "z-[1000] bottom-3 left-3"
              : // banner is top-16, two lines on a phone
                `z-[900] left-3 ${banner ? "top-36" : "top-16"} ${
                  legends === "top-left-on-phone"
                    ? "md:top-auto md:bottom-3 md:z-[1000]"
                    : ""
                }`
          }`}
        >
          <div className="pointer-events-auto space-y-2">
            {legend ? (
              legend({ city, available })
            ) : (
              <LayerLegend active={activeOverlays} city={city} />
            )}
            {OVERLAYS.filter((overlay) => activeOverlays.has(overlay.id)).map(
              (overlay) =>
                overlay.legend ? (
                  <div key={overlay.id}>{overlay.legend}</div>
                ) : null,
            )}
          </div>
        </div>
        {/* Under the dialogs' 1100, over the map's own chrome. */}
        {banner ? (
          <div className="absolute inset-x-3 top-16 z-[1050] mx-auto flex w-fit items-center gap-3 rounded-2xl bg-slate-900/90 px-4 py-2.5 text-sm font-medium text-white shadow-xl backdrop-blur-md dark:bg-slate-100/95 dark:text-slate-900">
            <span>{banner}</span>
            <button
              type="button"
              onClick={() => setBanner(null)}
              aria-label="Dismiss"
              className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-white/70 hover:bg-white/10 hover:text-white dark:text-slate-500 dark:hover:bg-slate-900/10 dark:hover:text-slate-900"
            >
              <FiX />
            </button>
          </div>
        ) : null}
        {ownSearch ? (
          <SearchControl
            city={city}
            open={searchOpen}
            pinned={searchPin !== null}
            center={mapCenter}
            onOpenChange={handleSearchOpen}
            onSelect={handleSearchSelect}
            onDirections={handleToggleRouting}
            onClear={handleSearchPinRemove}
          />
        ) : null}
        {panels}
        {editing ? (
          <PinEditor
            target={editing.mode === "create" ? editing.draft : editing.pin}
            mode={editing.mode}
            onSave={handleSave}
            onDelete={editing.mode === "edit" ? handleDelete : undefined}
            onCancel={handleCancel}
          />
        ) : null}
        {signingIn ? <SignInDialog onClose={handleCloseSignIn} /> : null}
        {aboutOpen ? <AboutDialog onClose={() => setAboutOpen(false)} /> : null}
      </main>
    </CityProvider>
  );
}
