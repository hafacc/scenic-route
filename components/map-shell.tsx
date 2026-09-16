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
  setSearchCentre,
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

// leaflet touches `window` at module load, so the map must be client-only
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
  | { kind: "loading" } // graph fetch or search in flight
  // The graph travels WITH the result. Directions are built by indexing a result's edge numbers into
  // a graph's arrays, so the two have to be the same city's — and they were separate pieces of state,
  // written by separate updates, with nothing to say so. Mid-switch that indexed one city's route
  // into another city's edges. Carrying it here makes the mismatch unrepresentable.
  | { kind: "ready"; result: RouteResult; graph: RoutingGraph }
  | { kind: "error"; message: string };

const RESNAP_METERS = 25; // a followed location must drift this far before the route recomputes
// Street level, where the first fix frames you. Matches what the map's own follow camera zooms to.
const LOCATED_ZOOM = 16;
// Where a searched place is framed — the same street level, and only ever zoomed IN to: someone
// already looking at one block asked where a park is, not to be pulled back out to see it.
const SEARCH_PIN_ZOOM = 16;
// How close to the route a POI must be to count as passed.
const LANDMARK_PASS_METERS = 40;
const ART_PASS_METERS = 40;

// A city's graph and snap index are fetched and built once, on first Directions use, and shared by
// every recompute and the route layer's geometry lookups. Keyed by city so switching and coming back
// does not rebuild an index over 600k edges.
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
      // Handed to the worker here rather than at the first route: it decodes its own copy of the
      // bytes while this thread builds the snap index, so the first search waits for neither.
      void routerClient()
        .load(cityId, graph)
        .catch(() => {}); // the route effect awaits the same promise and reports it
      return { graph, index: buildSnapIndex(graph) };
    })
    .catch((error: unknown) => {
      routingPromises.delete(cityId); // a failed load must not be memoized
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

// A point outside the city is a different failure from a point inside it with no pavement nearby, and
// saying "300 m from a walkable street" about somewhere the app has never held data for reads as a gap
// in the map rather than as the edge of what is covered.
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

// The `brand` ramp Tailwind resolves every accent class through, rederived from one hex so a deck
// hands over a colour rather than six. Mixed in oklab, which keeps each hue's own lightness curve;
// the percentages are where emerald's own stops sit against emerald-600.
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

// Everything a deck renders from. The shell owns all of it; the deck adds only its own way of
// putting the question, weights or a mode.
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
  // Deep-linked from the hash, so it is the shell's even though the dialog is a deck's to render.
  settingsSection: string | null;
  onSettings: (section: string | null) => void;
  syncingAs: string | null;
  // Read at share time rather than passed as a value: a pan must not re-render the deck.
  camera: () => Camera | null;
  // Whether the link at load has been read, so a deck's hash writer may start.
  hashApplied: boolean;

  routingOpen: boolean;
  onToggleRouting: () => void;
  // An endpoint marker is under the finger. A deck that does not solve live says so with it.
  dragging: boolean;
  manualStart: Endpoint | null;
  dest: Endpoint | null;
  searchPin: SearchPin | null;
  destPrefill: DestPrefill | null;
  hasLiveLocation: boolean;
  // What the reader asked for rather than what we snapped it to, for the Google Maps export.
  exportOrigin: LatLng | null;
  // The pins that export hands over, planned in the worker for whichever route is THE one; null
  // until they land, which is the whole of the button's disabled state.
  waypointPlan: WaypointPlan | null;
  pickTarget: "start" | "dest" | null;
  routeState: RouteState;
  // What a deck reads its factor maxima off, and what a route's edge numbers index into.
  graph: RoutingGraph | null;
  // What the GRAPH says can be routed on, all of it false until the graph lands: a control for data
  // that may not be there is a control that might move nothing. `available` is the same question
  // answered with the city's authored list while the graph is still coming, which is what a mode
  // builds its weights from.
  graphAvailable: FactorAvailability;
  // A sidewalk-shed feed, which is fetched apart from the graph and so is not one of the above.
  shedFeed: boolean;
  // What this city can be routed on, and the weights the deck's own answer to it came out as.
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
  // The place search, for a deck that runs the box itself rather than letting the shell float one.
  onSearchSelect: (result: GeocodeResult) => void;
  onSearchClear: () => void;
  onSearchDirections: () => void; // the found place becomes the destination
}

// Two slots rather than one because the shell's own chrome sits between them and nothing carries a
// z-index that would sort it out: `controls` are the deck's top buttons, `panels` its bottom card.
export interface Deck {
  controls: ReactNode;
  panels: ReactNode;
}

// How a deck turns one snapped pair into the route on screen. Null means a newer request overtook
// this one, as the worker itself answers.
export interface SolveRequest {
  city: City;
  clock: RouteClock;
  weights: RouteWeights;
  start: Snap;
  dest: Snap;
  // The graph the endpoints were snapped against, rather than whichever one state last landed on.
  graph: RoutingGraph;
}

export interface SolveReply {
  result: RouteResult | null;
  changed: boolean; // false where the path is the drawn one, so the map is left alone
  // Whether this search's own sun/shade field was (re)built, and whether its artifact failed with
  // it. The search runs where the field is, so only its answer knows.
  shadeRebuilt?: boolean;
  shadeLost?: boolean;
}

// What a deck's weights and layer set are an answer about. Both are the shell's own state, so a
// deck that decides either from them hands in a function rather than a value it would have to
// mirror.
export interface RoutingContext {
  city: City;
  available: FactorAvailability;
}

interface MapShellProps {
  weights: RouteWeights | ((context: RoutingContext) => RouteWeights);
  // The shell mounts and keys them; choosing them is the deck's.
  activeOverlays:
    | ReadonlySet<OverlayId>
    | ((context: RoutingContext) => ReadonlySet<OverlayId>);
  // The link at load, for the deck's own keys, applied in the same commit as the shell's. Called
  // once, so its identity has to be stable.
  onLink: (params: URLSearchParams) => PlaceUrlState;
  deck: (shell: ShellDeck) => Deck;
  // The search itself, when the deck runs its own. Absent asks the worker for one route.
  solve?: (request: SolveRequest) => Promise<SolveReply | null>;
  // Which route to treat as THE one when the deck offers several; it carries its own graph for
  // the reason `RouteState` does.
  chosen?: { result: RouteResult; graph: RoutingGraph } | null;
  // Every route on offer, drawn together with the selected one over the rest.
  lines?: readonly RouteLine[];
  onSelectLine?: (index: number) => void;
  // Which line the pointer is over, for a deck that draws it the way the chosen one is drawn.
  onHoverLine?: (index: number | null) => void;
  // Modes floats the overlay keys under the follow button on a phone, its card being the whole
  // bottom there; a wide screen has room for them where they have always been.
  legends?: "bottom-left" | "top-left" | "top-left-on-phone";
  // Whether the shell floats its own search button and panel. A deck that puts the box in its own
  // card takes the machinery off `ShellDeck` instead, so the two never share the panel slot.
  ownSearch?: boolean;
  // The deck's card is the page rather than a panel that opens, so the routing state never closes.
  alwaysRouting?: boolean;
  // The app's accent, as one hex: Modes follows the active mode, and everything wearing a `brand`
  // class follows it. Absent leaves the theme's own.
  accent?: string | ((context: RoutingContext) => string);
  // A tap armed from the deck's search box answers that box — drops the pin, names it — rather than
  // setting the destination, for as long as the deck is asking where to go rather than routing there.
  tapSearch?: boolean;
  // Whether an endpoint drag re-solves each frame. A deck that plans a whole set of routes replans
  // once on the drop instead, since a sweep cannot keep up with a finger.
  liveDrag?: boolean;
  // The layer key, where the deck draws its own; absent gets the shared one.
  legend?: (context: RoutingContext) => ReactNode;
  // The instant to route at, for a deck that holds one. Absent follows the wall clock, re-costing
  // the route every minute; a deck that hands one in is asking for the opposite — the search reruns
  // when this changes and at no other time, so the answer on screen stays the answer to the question
  // that was asked. Its identity is the trigger, so it has to be state rather than a fresh object.
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
  // The one city whose graph, tiles and overlays are live. It follows the map centre, so panning to
  // another city switches to it rather than leaving the previous city's data drawn under a view it
  // does not cover.
  const [city, setCity] = useState<City>(DEFAULT_CITY);
  const [signingIn, setSigningIn] = useState<boolean>(false);
  // Bound to the URL hash so About is deep-linkable (#about) and the back button closes it.
  const [aboutOpen, setAboutOpen] = useHashFlag("about");
  // Carries WHICH group was asked for, so the layers menu can land the reader on the layers.
  const [settingsSection, setSettingsSection] = useHashSection("settings");
  const [locationError, setLocationError] = useState<
    "denied" | "unavailable" | null
  >(null);
  // Bumped to ask for location again: the watch below is registered once per value of it. Without a
  // retry a reader who allows location in Settings after refusing it gets nothing until the app is
  // relaunched, and iOS keeps a home-screen app alive for days — which is most of what "Safari finds
  // me but the installed app cannot" is.
  const [locationAttempt, setLocationAttempt] = useState<number>(0);
  const standalone = useStandalone();
  const [banner, setBanner] = useState<string | null>(null);
  // The basemap is the one layer with no menu row to badge, and the one whose absence leaves the map
  // unreadable rather than just emptier — overlays floating on blank ground with no streets to place
  // them against. It gets the banner.
  const handleBasemapLost = useCallback((lost: boolean) => {
    if (lost) {
      setBanner("Map background unavailable — check your connection.");
    }
  }, []);
  const [routingWanted, setRoutingOpen] = useState<boolean>(false);
  const routingOpen = alwaysRouting || routingWanted;
  // Search and directions are one panel slot, so the app holds both flags: opening either closes the
  // other, and neither is restored when the other goes.
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
  // which field, if any, has armed a map tap to set its location
  const [pickTarget, setPickTarget] = useState<"start" | "dest" | null>(null);
  // A destination carried as words rather than as a point — a `#q=` link, or an Android share. Held
  // until it has been resolved into a place rather than read from the URL where it is wanted, since
  // the URL is stripped the moment it is read and the city it must be resolved against can still
  // change afterwards; cleared once it resolves, and when the reader answers the box themselves.
  const [destQuery, setDestQuery] = useState<string | null>(null);
  // What that query resolved to when it resolved to nothing certain: the words go into the
  // destination box with their candidates under them, and the reader picks.
  const [destPrefill, setDestPrefill] = useState<DestPrefill | null>(null);
  // Whether the last attempt to build the sun/shade field failed. The graph is fetched once and its
  // own maxima gate the other sliders (`capabilities`); this artifact is refetched every time the
  // clock moves, so it can go missing with the graph perfectly healthy — and then the slider sits
  // there moving nothing, which is what this is for.
  const [shadeDataLost, setShadeDataLost] = useState<boolean>(false);
  const [routeTimeTick, setRouteTimeTick] = useState<number>(0);
  // The decoded graph, kept so directions can be rebuilt from a route without a re-fetch.
  const [routingGraph, setRoutingGraph] = useState<RoutingGraph | null>(null);
  // What the graph can be routed on, which is what a mode builds its weights from. Until it lands
  // the city's authored layer list is the same fact, and all there is.
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
  // The landmark and public-art points, loaded once directions are in use, so the turn-by-turn can
  // name the ones the route passes.
  const [poiSets, setPoiSets] = useState<{
    landmarks: PoiSet;
    art: PoiSet;
  } | null>(null);
  // The maneuver list toggles open below the summary; it collapses whenever the destination changes.
  const [directionsOpen, setDirectionsOpen] = useState<boolean>(false);
  // The panel can shrink to a slim peek bar so the map stays usable while navigating.
  const [panelMinimized, setPanelMinimized] = useState<boolean>(false);
  // The start point routing actually uses: the manual start when set, else the live location snapped
  // through the resnap threshold so a followed GPS stream doesn't rerun the search on every fix.
  const [resolvedStart, setResolvedStart] = useState<{
    lat: number;
    lng: number;
  } | null>(null);
  // the live fix resolvedStart is pinned to, so drift is measured against it, not every raw tick
  const startBasisRef = useRef<{ lat: number; lng: number } | null>(null);
  const [routeState, setRouteState] = useState<RouteState>({ kind: "idle" });
  // the endpoints a route was last computed for, so a slider move recomputes without a loading flash
  const routedForRef = useRef<{
    start: { lat: number; lng: number };
    dest: { lat: number; lng: number };
  } | null>(null);
  // The page's own copy of the three route-time fields. Every search runs in the worker, which keeps
  // its own; these are for the two readers on this side — the maneuver list, which needs the ferry
  // timetable to name a sailing, and the Google Maps export, which prices the route against all three.
  const contextsRef = useRef<RouteContexts | null>(null);
  contextsRef.current ??= new RouteContexts();
  // True while an endpoint marker is mid-drag, so the live recompute holds the drawn route instead of
  // flashing a loading state on every frame.
  const draggingRef = useRef<boolean>(false);
  const dragWhichRef = useRef<"start" | "dest">("dest"); // which endpoint the active drag moves
  // Reactive mirror of draggingRef, so the map's reframe can switch to zoom-out-only during a drag.
  const [dragging, setDragging] = useState<boolean>(false);
  // Bumped on drop to re-run the route effect for the exact recompute, since a start drop leaves the
  // resolved endpoints unchanged and nothing else would re-trigger it.
  const [routeRefreshNonce, setRouteRefreshNonce] = useState<number>(0);
  // Mirrors routeState.kind === "ready", so a recompute can still apply an unchanged cache result when
  // nothing is drawn yet (else the loading state would strand); kept in sync by the effect below.
  const hasReadyRouteRef = useRef<boolean>(false);
  // The drawn route's trip seconds, kept in sync below. A start-drag solves backward from the dest, so
  // it anchors the sun at this arrival time; null (nothing drawn yet) falls back to the departure sun.
  const lastTravelSecondsRef = useRef<number | null>(null);
  // The nonce the route effect last acted on, so a recompute can tell a drop (nonce bumped, lands
  // silently) from a fresh target (a new destination or start, which flashes the loading spinner).
  const lastAppliedNonceRef = useRef<number>(0);
  // The URL hash at load has been applied, so the live hash writer may start. Mirrored into a ref for
  // the camera callback, which is held by a long-lived map listener and must keep its identity.
  const [hashApplied, setHashApplied] = useState<boolean>(false);
  const hashAppliedRef = useRef<boolean>(false);
  // Whether the link itself named a city. A stored city does not count: it is where the visitor was
  // last time, and their live position is the better answer to "which city am I in".
  const linkedCityRef = useRef<boolean>(false);
  // The city the endpoints on screen were picked in, so a switch can tell a route it has outlived
  // from one that arrived with the city. Null while there are no endpoints.
  const endpointCityRef = useRef<string | null>(null);
  // Whether the first location fix has been tested against the covered cities; only that one decides.
  const coverageChecked = useRef<boolean>(false);
  // A shared link's camera, applied once by the map, and the destination it was framed around; null
  // leaves the map where it is and lets a fresh route frame itself.
  const [initialCamera, setInitialCamera] = useState<Camera | null>(null);
  const [preframedDest, setPreframedDest] = useState<LatLng | null>(null);
  // The one place the search has left on the map. It outlives the panel closing — that is what
  // makes it a way of looking something up rather than a step in setting a destination — and a
  // second search replaces it.
  const [searchPin, setSearchPin] = useState<SearchPin | null>(null);
  // The live camera, tracked for the share link without re-rendering on every pan.
  const cameraRef = useRef<Camera | null>(null);
  // Through a ref rather than a dependency of the search effect: a deck that plans rebuilds this
  // callback whenever its plan changes, and depending on it would search again on its own answer.
  const solveRef = useRef<MapShellProps["solve"]>(solve);
  solveRef.current = solve;

  // The armed tap answers the search box instead of the destination: the deck is still asking where
  // to go, and an answer there is a place found, not a walk begun. A start armed by hand still sets
  // the start — that end is not what the box is about.
  const tapFindsPlace =
    tapSearch && pickTarget === "dest" && dest === null && destPrefill === null;

  // Read out one by one: the deck hands in a fresh weights object whenever any weight moves, and
  // depending on the object itself would resubscribe on every drag.
  const {
    shade: shadeWeight,
    shelter: shelterWeight,
    allowSheds,
    allowFerries,
    allowTransit,
  } = weights;
  // While anything the route reads moves with the clock, follow it: each tick re-costs the route
  // against the sun's new position and against the sailing a ferry terminal is next offering, and a
  // tick that lands on a new day also restands the scaffolding. The store only ticks in "now" mode or
  // on a scrub, and only with a listener.
  //
  // Ferries and trains are on by default, so this normally subscribes from the outset — which is the
  // point: an ETA built on "the 6:20 boat" has to stop saying so once 6:20 has gone.
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

  // A note written while the device was offline is queued in Firestore's own cache, and that cache
  // only drains once something has built the Firestore instance. A signed-out visitor builds nothing
  // — no settings to sync, no pins to read — so their note needs this launch to go and fetch it.
  useEffect(() => {
    flushPendingFeedback().catch(() => {});
  }, []);

  useEffect(() => {
    const unsubscribe = watchAuth((info) => {
      // onIdTokenChanged re-fires with a fresh AuthInfo each refresh; keep the old ref when uid+admin match to avoid a re-render
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

  // Settings follow the reader between their devices for as long as they are signed in. Keyed on the
  // uid alone, not on the auth object, which is replaced on every token refresh and would otherwise
  // tear the subscription down and build it up again each time.
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

  // The installed app is its own permission container: iOS copies cookies from Safari at install
  // time and nothing else, so a site allowed in Safari is a fresh ask here and browser settings do
  // not govern it. Sending an installed reader to the wrong Settings screen is worse than saying
  // nothing, and the app's own Location entry only exists once a request has run — which the retry
  // below is what re-runs.
  const locationHint =
    locationError === "denied"
      ? standalone
        ? "Location is blocked for this app — allow it in iOS Settings › Privacy & Security › Location Services › Scenic Route, then tap the location button. If Scenic Route is not listed, remove it from the Home Screen and add it again."
        : "Location access is blocked — enable it in your browser settings."
      : locationError === "unavailable"
        ? "Couldn't get your location. Make sure location services are on."
        : null;

  // Mirror any location error into the dismissible banner so every visitor sees it, not just admins.
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

  // follow centering lives in the map-side controller (reacts to userLocation + following)
  // biome-ignore lint/correctness/useExhaustiveDependencies: the attempt count is not read here, it is what re-issues the watch
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
        // The first fix is what opens the app on the city you are standing in. Nothing else can do
        // it: the URL named no city, the stored one is only where you were last time, and the camera
        // cannot pick a city it was never pointed at. A visitor outside every city gets the nearest
        // one and a banner saying so, since centring on ground the app has no data for is a blank
        // basemap that reads as a broken page.
        //
        // Only the FIRST fix decides, and only when the link named no city of its own — a link that
        // names one is a request to look there, which the visitor's own position does not override.
        if (!coverageChecked.current) {
          coverageChecked.current = true;
          const nearest = nearestCity({ lat, lng });
          if (!containsPoint(nearest, { lat, lng })) {
            setFollowing(false);
            setCity(nearest);
            setTarget({ ...nearest.center, zoom: CITY_ZOOM });
          } else if (!linkedCityRef.current) {
            // The camera moves with the city, not after it: the map is still framed wherever it
            // opened, and the camera reports what it can see, so leaving it there let it report the
            // old city back and undo this the moment it settled.
            //
            // This target and the link's own initial camera can never both be set — a link with a
            // camera has a city, and a city here means `linkedCityRef` and no adoption. Keep it that
            // way: were both live in one commit, which of them framed the map would come down to
            // which component React happened to run first.
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

  // The live fix, but only while the active city could do anything with it. Routing stays within one
  // city, so a fix outside the one on screen is not a start, is not somewhere to centre, and is not a
  // "My location" the panel can offer. Everything that reads the fix as an input to this city reads
  // this instead, so the panel, the camera and the search cannot disagree about whether it counts.
  const routableLocation =
    userLocation && containsPoint(city, userLocation) ? userLocation : null;

  // A visitor in New York opening San Francisco would otherwise have the first fix drag the camera
  // back across the country — and since the camera is what picks the city, that drag flipped the city
  // out from under the link, mid-route. Derived rather than an effect that clears `following`, because
  // the map's own follow effect runs on the same render as the fix that triggers it and would have
  // started the flight before any effect of this component could fire.
  const followLive =
    following && (userLocation === null || routableLocation !== null);

  // A route belongs to the city it was found in, so leaving that city ends it: its endpoints are
  // points the new city's graph cannot reach, and keeping them only turns the panel into an error
  // about a destination nobody is still asking for. The panel stays open, asking for a new one.
  //
  // Stated once here rather than called from each of the four places that change city, because those
  // callers cannot tell a switch apart from the city simply arriving: the link's own city lands in
  // the same commit as the endpoints it carried, and a camera that reports twice inside one tick
  // reports a stale city first. As a rule about what may coexist, both are answered by construction —
  // the endpoints record which city they were picked in, and only a change away from THAT clears
  // them. Ordered before the search effect so it never runs a pass on endpoints from another city.
  useEffect(() => {
    if (!dest && !manualStart) {
      endpointCityRef.current = null;
      return;
    }
    if (endpointCityRef.current === null) {
      endpointCityRef.current = city.id;
    } else if (endpointCityRef.current !== city.id) {
      endpointCityRef.current = null;
      setDest(null);
      setManualStart(null);
      setPickTarget(null);
      setRouteState({ kind: "idle" });
      routedForRef.current = null;
      routerClient().reset();
    }
  }, [city, dest, manualStart]);

  // A searched pin belongs to the city it was found in exactly as the endpoints above do: its name
  // came out of that city's index, the other city cannot draw it, and a share link would otherwise
  // pair one city's key with the other city's point. Its own ref for the same reason theirs exists —
  // a link's city lands in the same commit as the pin it carried, which is the pin arriving rather
  // than a switch away from it.
  const pinCityRef = useRef<string | null>(null);
  useEffect(() => {
    if (!searchPin) {
      pinCityRef.current = null;
    } else if (pinCityRef.current === null) {
      pinCityRef.current = city.id;
    } else if (pinCityRef.current !== city.id) {
      pinCityRef.current = null;
      setSearchPin(null);
    }
  }, [city, searchPin]);

  // Asking again, from a control the reader pressed — which is both what picks up a permission they
  // have just granted in Settings and, on iOS, the gesture WebKit would rather see a prompt come
  // from. Clearing the error first is what lets a second refusal re-raise a banner already dismissed.
  const retryLocation = useCallback(() => {
    if (userLocation === null) {
      setLocationError(null);
      setLocationAttempt((attempt) => attempt + 1);
    }
  }, [userLocation]);

  // The toggle reads and writes the derived state, so pressing it always does what the button says.
  // Engaging it from a city you are not in means "take me to me", which moves the active city with
  // the camera rather than lighting a control that centres nothing.
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

  // Picking a city frames it and stops following, since the visitor has just said they want to look
  // somewhere other than where they are.
  const handleSelectCity = useCallback((picked: City) => {
    setFollowing(false);
    setCity(picked);
    setTarget({ ...picked.center, zoom: CITY_ZOOM });
  }, []);

  // Assigned during render, not in an effect: the layers below read it while their own effects run,
  // which is before any effect of this component would have fired. Idempotent, so a repeated render
  // cannot leave it wrong.
  setActiveCity(city);

  // Dropped on a switch, so the old city's names cannot survive the move.
  useEffect(() => {
    setPoiSets(null);
    // The graph says which controls this city can answer, so holding the old one leaves sliders lit
    // for data the new city does not have — the hill slider stayed enabled in New York after San
    // Francisco. Null is the honest answer until this city's own graph lands.
    setRoutingGraph(null);
    // The two files the search box answers from with no signal — every name in the city, and the
    // house numbers its worker resolves them against — pulled onto the device now rather than when
    // someone types at it, because a file only fetched once you have already searched offline is a
    // file you never have when you need it. Ten megabytes against the graph's thirty-nine, and on
    // an idle callback so they queue behind the first paint. Reading them into the index is a
    // separate, later decision (below) — this only puts them within reach.
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

  // The decoded index is forty megabytes and two panels read it — the route fields and the search
  // box — so it is loaded while either is open and dropped once neither is. Opening a panel is early
  // enough that the tables are ready before anything is typed, and it spares every visitor who only
  // ever looks at the map: on a phone already holding the graph and a screenful of tile canvases,
  // that is the difference between a session iOS tolerates and one it kills.
  //
  // Both panels, not just the routing one. They share a slot, so opening the search closes the route
  // panel — keyed on that alone this would tear the worker down underneath the box that was about to
  // ask it something, and then never drop it again for a reader who only ever searches.
  useEffect(() => {
    if (routingOpen || searchOpen) {
      warmNameIndex(city.id);
    } else {
      releaseNameIndex();
    }
  }, [routingOpen, searchOpen, city]);

  // stable identity for a long-lived map listener; functional updater keeps disengage idempotent
  const handleDisengageFollow = useCallback(() => {
    setFollowing(() => false);
  }, []);

  // Resolve the routing start: a manual start is used verbatim; otherwise the live location, adopted
  // on the first fix and thereafter chased only when it drifts past the resnap threshold, so a
  // followed GPS stream doesn't churn the search. Clearing the manual start snaps to live at once.
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
      // A live fix outside the active city is not a start: adopting it guarantees the search fails on
      // a point it was never going to reach. Dropping it leaves the panel asking for a start, which is
      // the honest state.
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

  // The city a route belongs to. Captured as a value and threaded through the whole search rather
  // than read from the `activeCity()` global at each step, because that global moves under the
  // search: a first location fix or a camera settle can reselect the city while a graph fetch is in
  // flight, and the effect would then load one city's graph and report the result against another's
  // name and bounds. With a visitor located in New York opening directions in San Francisco, that
  // race left the route computed and never drawn. It is a dependency of the search for the same
  // reason — changing city has to recompute the route, not silently repoint the labels.
  const routeCity = city;

  // The wall clock as the router reads it, remade each minute the store ticks. A deck holding its
  // own departure instant takes its place, and the tick then moves nothing that is routed. The page
  // and the worker are handed this same instant, so they build their fields for it and catch the
  // same boat.
  const liveClock = useMemo<RouteClock>(
    () => ({ tick: routeTimeTick, dateMs: getResolvedDate().getTime() }),
    [routeTimeTick],
  );
  const routeClock = clockProp ?? liveClock;

  // Which sliders this city can actually answer, from the same reading of the graph the modes make.
  // Everything reads false until the graph lands, which is the honest answer while nothing is known;
  // the panel is not routing yet either.
  const graphAvailable: FactorAvailability = useMemo(
    () => graphFactors(routingGraph),
    [routingGraph],
  );
  // The scaffolding gate is the exception: sheds are fetched separately from the graph, so it asks
  // the city's overlay list, where a city with no shed feed omits the layer.
  const shedFeed = city.overlays.includes("scaffolding");

  // Live recompute: whenever a resolvable start and a destination both exist, (re)find the route,
  // keyed on the endpoints and the tree weight and rAF-coalesced so a slider drag computes at most
  // once per frame. The loading flash shows for a fresh endpoint pair unless the recompute came from
  // an endpoint drop (which holds the drawn route until the exact one lands); a slider move re-costs in
  // place. Writes only routeState/routedForRef (neither a dep).
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
    // A deck that replans on the drop draws nothing new while the marker moves: the plan on screen
    // is held, and the drop's own recompute is what replaces it.
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
    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      // A drop bumps routeRefreshNonce; that recompute lands silently so the drawn route holds until
      // the exact one is ready. Any other trigger (a new destination or start) shows the spinner.
      const isDropRefresh = routeRefreshNonce !== lastAppliedNonceRef.current;
      lastAppliedNonceRef.current = routeRefreshNonce;
      if (isNewTarget && !draggingRef.current && !isDropRefresh) {
        setRouteState({ kind: "loading" });
      }
      loadRouting(routeCity.id)
        .then(
          async ({ graph, index }) => {
            if (cancelled) {
              return;
            }
            // Replaced whenever the identity changes, not kept forever once set. `loadRouting` hands
            // back one stable graph PER CITY, so `current ?? graph` held New York's for the whole
            // session: switching to San Francisco left the hill slider greyed out (this graph is what
            // says which layers a city has) and built San Francisco's turn-by-turn directions against
            // New York's edges. The identity check keeps the re-render, which is what `??` was for.
            setRoutingGraph((current) => (current === graph ? current : graph));
            routedForRef.current = request;
            const client = routerClient();
            // Waited on: a graph the worker could not decode has to reach the panel as an error,
            // not as a request queued behind a city that never loaded.
            await client.load(routeCity.id, graph);
            if (cancelled) {
              return;
            }
            const contexts = (contextsRef.current ??= new RouteContexts());
            // The timetable alone: the page reads it to name a ferry leg, and the worker builds
            // every field a search is costed against on its own copy of the graph.
            await contexts.syncFerries(graph, routeCity, routeClock, weights);
            if (cancelled) {
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
            // Mid-drag the worker reuses a per-gesture solver rooted at the held endpoint for an
            // approximate route each frame; the drop recomputes exactly. A start-drag solves backward
            // from the dest, so it anchors the sun at the drawn route's arrival time.
            const solveOne = solveRef.current;
            // The graph goes to the deck's own solver, which runs on this thread; the worker has
            // its own copy of it and is sent the endpoints alone.
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
            // Null means a newer frame overtook this one in the worker; it will answer instead.
            if (cancelled || !reply) {
              return;
            }
            // Only when this pass actually rebuilt the field: a clock scrub starts a fetch per tick, and
            // a slow failure landing after a later tick has already succeeded would otherwise grey out a
            // slider whose data is loaded and being used.
            if (reply.shadeRebuilt) {
              setShadeDataLost(reply.shadeLost ?? false);
            }
            // Identical to the drawn route (a slider move that didn't cross a breakpoint): leave it —
            // but always apply when nothing is drawn yet, or an unchanged result would strand the
            // loading state. A drop resets the brackets first, so its exact route reads as changed anyway.
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
            if (!cancelled) {
              setRouteState({
                kind: "error",
                message:
                  "Couldn't load the routing data. Check your connection.",
              });
            }
          },
        )
        .catch((error: unknown) => {
          // The worker refusing a request: not a network failure, but the panel has one way to say a
          // route could not be found, so the console carries what actually happened.
          console.error("routing failed:", error);
          if (!cancelled) {
            setRouteState({
              kind: "error",
              message: "Couldn't load the routing data. Check your connection.",
            });
          }
        });
    });
    return () => {
      cancelled = true;
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

  // A new destination collapses any open maneuver list; keyed on the coordinates so a reverse-geocode
  // label patch (same point, new object identity) doesn't snap it shut.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on the destination point, not the object identity
  useEffect(() => {
    setDirectionsOpen(false);
  }, [dest?.lat, dest?.lng]);

  const handleToggleDirections = useCallback(() => {
    setDirectionsOpen((open) => !open);
  }, []);

  const handleToggleMinimize = useCallback(() => {
    setPanelMinimized((on) => !on);
  }, []);

  // Closing directions clears everything but the slider values. Its own control does this, and so
  // does opening the search, which takes the slot the panel was in.
  const closeRouting = useCallback(() => {
    setDest(null);
    setManualStart(null);
    setPickTarget(null);
    setRouteState({ kind: "idle" });
    routedForRef.current = null;
    // The peek bar is a way of getting a computed route out of the way, so it has no meaning over
    // an empty panel: without this, closing directions while minimized and opening them again
    // brings back a slim bar with nothing in it and no obvious way to see the fields.
    setPanelMinimized(false);
    setRoutingOpen(false);
  }, []);

  // Answering the destination box — by picking a row, by clearing it, or by tapping the map — retires
  // any query a link arrived with: the reader has said what they want, and a lookup still running for
  // words they have moved past must not overwrite it.
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

  // Clearing the start — via the X or the dropdown's "My location" row — resets it to the live position.
  // Both clearing the start and asking for "my location" mean the same thing here: route from the
  // live fix. So they are also the two places worth asking for one again when there is none.
  const handleClearStart = useCallback(() => {
    setManualStart(null);
    setPickTarget((target) => (target === "start" ? null : target));
    retryLocation();
  }, [retryLocation]);

  // Exchange the two ends. Nothing is re-geocoded — the labels travel with their points — and the
  // solve effect re-fires on the new pair and searches again from scratch. Deliberately NOT the
  // reverse solver the drags use: that re-times the path it already has, and the costs are
  // directional (hills, ferries, sun), so the way back is a different route, not this one read
  // backwards.
  //
  // A start reading "My location" cannot reach here with a destination set — the promotion effect
  // below has already pinned it to a point by then. Without a destination the swap moves the start
  // into the empty destination box and lets the start fall back to the live fix; with only a
  // destination it does the same in reverse, which is the way out of typing a start into the wrong
  // box.
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
      // "Dropped pin" is immediate feedback; the reverse geocode replaces it when it lands.
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

  // A place marked on the map without a name yet: the pin lands at once and the reverse geocode
  // replaces "Dropped pin" when it arrives, which is what the search box then reads.
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

  // Asking for directions pins where you are. Until a destination exists the start tracks the live
  // position and reads "My location", which is right for a start you have not committed to — but once
  // it is one end of a route, following would move it under you as you walk, and it would go into a
  // shared link as nothing at all, leaving whoever opened it routing from THEIR position. So the live
  // position is promoted to a real point, reverse-geocoded like any picked one. Clearing the start
  // afterwards re-pins it to wherever you are then.
  //
  // Only a fix this city can route from is promoted, for the reason the start resolver gives: pinning
  // one from another city turns a link someone opened into an immediate routing error against a start
  // they never chose.
  useEffect(() => {
    if (!dest || manualStart || !routableLocation) {
      return;
    }
    applyPick("start", routableLocation.lat, routableLocation.lng);
  }, [dest, manualStart, routableLocation, applyPick]);

  // Each frame of an endpoint drag: move that end's coordinate so the route recomputes live, keeping
  // the prior label (a reverse geocode would spam the network) until the drag settles.
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

  // Drop of a dragged endpoint: settle that end, discard the approximate solver, and reverse-geocode
  // its label. The drag bypassed the route cache, so reset it (its stale baseline would otherwise read
  // the exact drop route as unchanged) and bump the nonce to re-run the exact recompute.
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

  // One-shot init from the URL hash, layered over the persisted preferences: a key in the link wins, a
  // missing one keeps what the sliders were last left at, and a link with no view keys leaves the
  // camera and overlays alone. Enables the hash writer only once done, so opening a link never
  // rewrites it out from under itself.
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
      // Carried as a bare point, like `from` and `to`, and named back the same way they are. The
      // point is the index's own coordinates, so the lookup lands on the very row the sharer picked.
      dropSearchPin(route.pin.lat, route.pin.lng);
    }
    if (route.dest) {
      applyPick("dest", route.dest.lat, route.dest.lng);
      setRoutingOpen(true);
      // A link that names a route is a request to look at that route, so the first location fix does
      // not get to centre the map on the visitor instead — even when they are in the same city as it.
      setFollowing(false);
      void loadRouting(activeCity().id); // warm the graph, as opening the panel by hand does
    }
    const view = decodeView(params);
    // Three sources, in this order and no other: the link, then where you are, then the default. The
    // last city you looked at is deliberately NOT one of them — it was remembered in localStorage and
    // beat the live fix, so a visitor in San Francisco who had once opened New York kept being shown
    // New York. Nobody asked to be taken back to where they were last time.
    // A destination names a city as surely as the city key does: it is a point in exactly one of
    // them, and it is what the visitor opened the link to see.
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
      setFollowing(false); // else the first location fix yanks the shared camera away
    } else if (route.pin) {
      // A pin has no route whose bounds could frame it, so the link's framing is the pin itself.
      setInitialCamera({ center: route.pin, zoom: SEARCH_PIN_ZOOM });
      setFollowing(false);
    } else if (linked) {
      // A chosen city with no camera to go with it still has to frame that city before the map
      // settles: the camera is what decides which city is active, so opening on the default one and
      // correcting afterwards would just switch straight back.
      setInitialCamera({ center: linked.center, zoom: CITY_ZOOM });
    }
    hashAppliedRef.current = true;
    setHashApplied(true);
  }, [applyPick, dropSearchPin, onLink]);

  // A destination named in words rather than as a point: the `q` key of a shared link, or the text
  // Android's share sheet hands the installed app. Both land here because both say the same thing,
  // and the city's own index resolves them without a network — which is the only reason this can be
  // acted on at all. Read once and taken straight back out of the URL, so a link cannot fire twice
  // on reload or travel on to the next person carrying a destination they never asked for; the words
  // themselves live in `destQuery` from then on. The box opens with them in it immediately, before
  // anything is known about what they mean.
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

  // Resolving those words against a city. An exact house number is routed to; anything vaguer fills
  // the box with the words and the answers found for them and lets the reader choose, because a
  // shared "Joe's" that silently routes to one of eleven is worse than a list of eleven. The answers
  // are handed to the box rather than left for it to search again: it searches on a timer after the
  // words land, which on the cold load this feature exists for asks an index that has not arrived
  // and gets nothing, with no second keystroke coming to ask again.
  //
  // Threaded a captured `city` rather than letting `searchAddress` read the live one, for the reason
  // spelled out at `routeCity` above: a first location fix can reselect the city while the index is
  // still loading, and answering about the wrong city's streets is worse than answering late.
  //
  // That fix is also why the words are held in state rather than consumed where the URL is read. A
  // `q` link names words, not a place, so unlike one carrying coordinates it cannot say which city
  // it means — it must not be treated as having chosen one, or a visitor standing in San Francisco
  // would be answered out of New York's streets. So the fix is left free to move the city, and this
  // resolves again in the new one instead of dropping the destination. Waiting for the index is what
  // makes that window wide enough to matter: on a cold load the fix lands long before the tables do.
  useEffect(() => {
    if (destQuery === null) {
      return;
    }
    let cancelled = false;
    const cityId = city.id;
    // Waits for the index rather than searching without it. A shared link is opened cold, so the
    // files are usually still arriving, and asking early would answer "nothing found" about an
    // address the city certainly has.
    awaitNameIndex(cityId)
      .then(() =>
        resolveSharedQuery(destQuery, cityId, searchAddress, () => cancelled),
      )
      .then((found) => {
        if (cancelled || found === null) {
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
      cancelled = true;
    };
  }, [destQuery, city]);

  const handleCamera = useCallback((camera: Camera, view: CityBounds) => {
    cameraRef.current = camera;
    // Where the map is decides which city is active — but not yet. The first report comes from the
    // container's default centre, which is the default city rather than anything anyone chose, and it
    // lands before the hash effect has read the link. Answering it would set the city from the default
    // and leave the link to correct it afterwards, which is the race this ordering removes.
    if (!hashAppliedRef.current) {
      return;
    }
    // Settled moves only, and this bails when the id is unchanged, so it costs one lookup per gesture
    // rather than one per frame. Read against the active city rather than through a functional update
    // because leaving a city has to clear its route too, which a state updater may not do.
    //
    // One city on screen and no other is the whole test. Where the centre happens to sit does not
    // enter into it: a view wide enough to hold two cities is not a view that has chosen between
    // them, however the centre falls, and switching there would throw away the route of whichever
    // one you actually had. So a city takes over only once it is alone in frame — which for
    // neighbours like Oakland and San Francisco means zooming in far enough to leave the other
    // behind, and that is the same gesture as saying which one you mean.
    // Proposed through the updater rather than compared against the city read from the last
    // render. A settled camera fires several times inside one tick — a synchronous setView reports
    // synchronously — so a comparison outside the updater reads a value the previous report has
    // already queued a change to, and the stale one wins. The updater always sees the latest.
    const inView = citiesInView(view);
    if (inView.length === 1) {
      const [next] = inView;
      // The same one-city-in-frame test the switch uses, because it is the same question: this
      // centre only says anything about a city when it is the only one on screen. The address search
      // ranks the several streets of one name — New York has five Court Streets — by how near they
      // are to it, when the reader has not shared a location of their own.
      setSearchCentre(next.id, camera.center);
      setCity((current) => (next.id === current.id ? current : next));
    }
  }, []);

  // Where the map is looking, for the search panel's coverage check. A function rather than a value
  // because the camera is tracked in a ref: a pan must not re-render the app.
  const mapCentre = useCallback(() => cameraRef.current?.center ?? null, []);

  const camera = useCallback((): Camera | null => cameraRef.current, []);

  // A map tap sets the armed field's location, and nothing at all when no field is armed: the map is
  // a map first, and a tap that placed a point unasked was one nobody could undo.
  const handleMapPick = useCallback(
    (lat: number, lng: number) => {
      if (pickTarget === null) {
        return;
      } else if (tapFindsPlace) {
        // The same answer a suggestion gives, so a tap never opens directions of its own accord.
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
          // high-accuracy fix failed; fall back to the last watched position
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
    // The map has just flown to the result, so following would drag it straight back.
    setFollowing(false);
  }, []);

  const handleSearchPinRemove = useCallback(() => {
    setSearchPin(null);
  }, []);

  // A found place becomes the route destination, so the search pin goes rather than the two sitting
  // on the same spot in the same green. The pin has no handle of its own, so this is the only way to
  // route to one, and the directions control is where it is asked for.
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

  // Asking for directions to the place the box has found, for a deck whose card holds the box.
  const handleSearchDirections = useCallback(() => {
    if (searchPin) {
      routeToSearchPin(searchPin);
    }
  }, [searchPin, routeToSearchPin]);

  // Reads the current values rather than toggling inside an updater: an updater must be pure, and
  // these branches are side effects. React invokes updaters twice in development to find exactly
  // this, and the next effect added inside one would not be as forgiving as these are.
  const handleToggleRouting = useCallback(() => {
    if (routingOpen) {
      closeRouting();
    } else if (searchOpen && searchPin !== null) {
      // Asking for directions with a place already found means directions TO that place: an empty
      // panel opening over the answer the reader is looking at would throw it away.
      routeToSearchPin(searchPin);
    } else {
      setSearchOpen(false);
      void loadRouting(city.id); // warm the graph so the first route lands without a fetch stall
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

  // The search wants the panel slot directions are in, so opening it closes them — and closing it
  // does not bring them back: whichever the reader opened last is the one that is open.
  //
  // A destination outlives the panel that set it, as a pin. Directions are a way of getting to a
  // place the reader had already settled on, so dropping the place along with the route would throw
  // away the part they chose. The search box stays empty: the pin is not something they typed here,
  // and prefilling it would invite a re-search for a place already on the map.
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
    // selecting a pin flies away from the user, so release follow rather than fight the watcher
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
      // optimistic close
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

  // Load the landmark and art points once the routing panel is in use, so directions can name the
  // POIs the route passes. A failed load just omits the names — they are a nice-to-have.
  useEffect(() => {
    if (!routingOpen || poiSets) {
      return;
    }
    let cancelled = false;
    Promise.all([
      loadPois(`landmarks/${city.id}.bin`, "LMRK"),
      loadPois(`art/${city.id}.bin`, "ARTW"),
    ]).then(
      ([landmarks, art]) => {
        if (!cancelled) {
          setPoiSets({ landmarks, art });
        }
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [routingOpen, poiSets, city.id]);

  // A deck offering several routes says which is THE route; otherwise the last search's.
  const routeResult =
    chosen?.result ?? (routeState.kind === "ready" ? routeState.result : null);
  // The graph the result was actually computed against, not whichever one state last landed on.
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
  // Live progress along the ready route from the current fix; null when off-route or unlocated, which
  // makes the panel fall back to the route summary. Recomputes as watchPosition updates userLocation.
  const progress = useMemo(
    () =>
      routeResult && directions && userLocation
        ? navProgress(routeResult, directions, userLocation)
        : null,
    [routeResult, directions, userLocation],
  );
  // What the reader asked for rather than what we snapped it to. Google re-snaps every coordinate to
  // its own network, and handing it our sidewalk point can put it across the street from the door.
  const exportOrigin = manualStart
    ? { lat: manualStart.lat, lng: manualStart.lng }
    : routableLocation
      ? { lat: routableLocation.lat, lng: routableLocation.lng }
      : null;

  // The pins the Google Maps export hands over, asked of the worker as soon as a route is drawn:
  // they are priced against the shade and shed fields, which only the worker builds, and planning
  // them costs about as much as the search did — far too much for the click that opens the tab.
  // Held with the route they describe, so the button is never handed a plan about another one.
  const [waypointPlan, setWaypointPlan] = useState<{
    route: RouteResult;
    plan: WaypointPlan;
  } | null>(null);
  useEffect(() => {
    // Mid-drag the route is replaced every frame, and one plan of a long walk would hold up the
    // frames behind it; the drop re-runs this.
    if (!routeResult || dragging) {
      return;
    }
    let cancelled = false;
    routerClient()
      .waypoints({
        cityId: routeCity.id,
        clock: routeClock,
        weights,
        steps: routeResult.steps,
      })
      .then(
        (plan) => {
          if (!cancelled && plan) {
            setWaypointPlan({ route: routeResult, plan });
          }
        },
        (error: unknown) => {
          console.error("waypoint planning failed:", error);
        },
      );
    return () => {
      cancelled = true;
    };
  }, [routeResult, dragging, routeCity, routeClock, weights]);

  // Start marker position: the snapped route start, else the manual start, else — while the routing
  // panel is open — the live location, so the start sits pre-dropped and draggable atop the location
  // dot before any destination is picked (drag it to set a manual start; it tracks the fix until then).
  // WHILE the start is being dragged it must follow the cursor (manualStart), not the snapped route
  // point — writing the snapped point back onto the marker mid-drag fights Leaflet's drag and strands it.
  const draggingStart = dragging && dragWhichRef.current === "start";
  const routeStart =
    !draggingStart && routeResult
      ? routeResult.start.point
      : manualStart
        ? { lat: manualStart.lat, lng: manualStart.lng }
        : routingOpen && routableLocation
          ? { lat: routableLocation.lat, lng: routableLocation.lng }
          : null;
  // The destination marker appears the moment a destination exists; the line follows live once both
  // endpoints resolve and the search lands.
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
        {/* the active overlays' floating keys; bottom-left keeps them clear of the toolbar, follow
          toggle, and the centered route and search panels — and top-left, under the follow button,
          where the deck's own card owns the bottom of the screen. Modes takes the third: the card
          is the whole bottom of a phone but only the right-hand corner of a wide screen. */}
        <div
          className={`pointer-events-none absolute max-w-[70vw] ${
            legends === "bottom-left"
              ? "z-[1000] bottom-3 left-3"
              : // Clear of the banner, which sits at top-16 and is two lines deep on a phone, and
                // under the toolbar's own layer, whose menu drops through this row.
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
        {/* under the dialogs' 1100, whose titles it used to cover, and over the map's own chrome */}
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
            centre={mapCentre}
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
