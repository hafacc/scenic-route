// The types map-shell.svelte and location-field.svelte share with the decks, without the shell.
import type { Snippet } from "svelte";
import type { City } from "../src/cities";
import type { AuthInfo } from "../src/firebase";
import type { GeocodeResult } from "../src/geocode";
import type { FactorAvailability } from "../src/modes/modes";
import type { OverlayId } from "../src/overlays/registry";
import type { Pin, PinDraft } from "../src/pin";
import type { RouteClock } from "../src/routing/contexts";
import type { RouteWeights } from "../src/routing/cost";
import type { Maneuver } from "../src/routing/directions";
import type { RoutingGraph } from "../src/routing/graph";
import type { NavProgress } from "../src/routing/nav-progress";
import type { RouteResult } from "../src/routing/search";
import type { Snap } from "../src/routing/snap";
import type { WaypointPlan } from "../src/routing/waypoints";
import type { Camera, LatLng, PlaceUrlState } from "../src/url-state";
import type { RouteLine, SearchPin } from "./map-types";

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

export type Editing =
  | { mode: "create"; draft: PinDraft }
  | { mode: "edit"; pin: Pin }
  | null;

export interface Endpoint extends LatLng {
  label: string | null;
}

export interface DestPrefill {
  text: string;
  results: GeocodeResult[];
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
  // Read at share time, not passed as a value, since the camera is no signal.
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

export interface MapShellProps {
  weights: RouteWeights | ((context: RoutingContext) => RouteWeights);
  activeOverlays:
    | ReadonlySet<OverlayId>
    | ((context: RoutingContext) => ReadonlySet<OverlayId>);
  // Called once, so its identity must be stable.
  onLink: (params: URLSearchParams) => PlaceUrlState;
  // Two slots because the shell's chrome sits between them and no z-index sorts it out.
  controls: Snippet<[ShellDeck]>;
  panels: Snippet<[ShellDeck]>;
  // Absent asks the worker for one route.
  solve?: (request: SolveRequest) => Promise<SolveReply | null>;
  // Carries its own graph, so the result and graph are always the same city's.
  chosen?: { result: RouteResult; graph: RoutingGraph } | null;
  lines?: readonly RouteLine[];
  onSelectLine?: (index: number) => void;
  onHoverLine?: (index: number | null) => void;
  // Only for a reset the shell makes on its own (leaving the city), not the deck's close button.
  onRoutingReset?: () => void;
  // Where the keys sit from `md` up; on a phone always under the toolbar, and above Modes' card.
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
  legend?: Snippet<[RoutingContext]>;
  // Absent follows the wall clock; when given, the search reruns only when it changes.
  clock?: RouteClock | null;
}
