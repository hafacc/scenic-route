<script module lang="ts">
import L from "leaflet";
import { onMount, untrack } from "svelte";
import { CROSS_CITY_METERS } from "../src/cities";
import { FERRY_COLOR } from "../src/overlays/colors";
import type { RoutingGraph } from "../src/routing/graph";
import {
  buildDrawing,
  type DrawStep,
  type RouteDrawing,
} from "../src/routing/route-drawing";
import type { RouteResult } from "../src/routing/search";
import { haversineMeters } from "../src/routing/snap";
import type { Subway } from "../src/subway/format";
import { loadSubwayTracks } from "../src/subway/tracks";
import { currentTheme } from "../src/theme/current";
import CanvasGrid from "../src/tiles/canvas-grid";
import { KEEP_BUFFER, tileRatio } from "../src/tiles/raster";
import { repeatable } from "../src/tiles/repaint";
import { useCity } from "./city-context";
import Marker from "./leaflet/marker.svelte";
import Polyline from "./leaflet/polyline.svelte";
import { getMap } from "./map-context";
import { destIcon, startIcon } from "./map-icons";
import type { RouteLine } from "./map-types";

const TILE_SIZE = 256;
const PANE_NAME = "route";
const PANE_Z_INDEX = 450; // above tiles (~200), below markers (~600)
const MIN_ZOOM = 3;
const MAX_ZOOM = 20;

// px from the viewport edge; Leaflet auto-pans the map to hold a dragged endpoint there.
const DRAG_AUTOPAN_PADDING: [number, number] = [80, 80];

// A neutral slate core in a white casing reads over any overlay.
const WIDTH_AT_Z16 = 4.5;
const WIDTH_PER_ZOOM = 1.3;
const MIN_WIDTH = 2.5;
const CASING_EXTRA = 3; // white halo, ~1.5 px each side

const ROUTE_COLOR = "#334155"; // slate-700
const CASING_COLOR = "#ffffff";
const CONNECTOR_COLOR = "#94a3b8"; // slate-400
const CONNECTOR_MIN_METERS = 15;
const CONNECTOR_STYLE: L.PathOptions = {
  color: CONNECTOR_COLOR,
  weight: 2,
  dashArray: "4 5",
};
// A change inside a complex: a thinner dashed line in the route's color, never the street walk's.
const TRANSFER_WIDTH = 0.6;
const TRANSFER_DASH = 2;
// A full-strength badge over a faint line would read as highlighted.
const ALT_WIDTH = 0.7;
const ALT_ALPHA = 0.35;
// A stroke has to be painted to receive a tap, hence the near-zero opacity.
const TAP_WIDTH = 18;
const TAP_OPACITY = 0.01;
const TAP_VERTICES = 400;

interface DrawBand {
  steps: DrawStep[];
  color: string;
  width: number; // multiple of the zoom-derived width
  alpha: number;
}

class RouteGrid extends CanvasGrid {
  private bands: DrawBand[] = [];

  setBands(bands: DrawBand[]): void {
    this.bands = bands;
    this.redraw();
  }

  createTile(coords: L.Coords): HTMLCanvasElement {
    const tile = document.createElement("canvas");
    const ratio = tileRatio();
    tile.width = TILE_SIZE * ratio;
    tile.height = TILE_SIZE * ratio;
    const context = tile.getContext("2d");
    if (context && this.bands.length > 0) {
      this.watch(
        tile,
        repeatable(context, ratio, (target) => {
          this.draw(target, coords);
        }),
      );
    }
    return tile;
  }

  // All casings first, then the colored lines, so round joins meet seamlessly.
  private draw(context: CanvasRenderingContext2D, coords: L.Coords): void {
    const map = this._map;
    const originX = coords.x * TILE_SIZE;
    const originY = coords.y * TILE_SIZE;
    const base = Math.max(
      MIN_WIDTH,
      WIDTH_AT_Z16 * WIDTH_PER_ZOOM ** (coords.z - 16),
    );
    let longest = 0;
    for (const band of this.bands) {
      for (const step of band.steps) {
        longest = Math.max(longest, step.lngs.length);
      }
    }
    const xs = new Float64Array(longest);
    const ys = new Float64Array(longest);

    for (const band of this.bands) {
      const width = base * band.width;
      const walkPath = new Path2D();
      const ferryPath = new Path2D();
      const transferPath = new Path2D();
      // One path per line ridden, each cased and stroked whole so its joins meet.
      const ridePaths = new Map<string, Path2D>();
      for (const step of band.steps) {
        const count = step.lngs.length;
        const margin = width;
        let low = Number.POSITIVE_INFINITY;
        let left = Number.POSITIVE_INFINITY;
        let high = Number.NEGATIVE_INFINITY;
        let right = Number.NEGATIVE_INFINITY;
        for (let vertex = 0; vertex < count; vertex++) {
          const point = map.project(
            L.latLng(step.lats[vertex], step.lngs[vertex]),
            coords.z,
          );
          xs[vertex] = point.x - originX;
          ys[vertex] = point.y - originY;
          left = Math.min(left, xs[vertex]);
          right = Math.max(right, xs[vertex]);
          low = Math.min(low, ys[vertex]);
          high = Math.max(high, ys[vertex]);
        }
        const overlaps =
          right >= -margin &&
          left <= TILE_SIZE + margin &&
          high >= -margin &&
          low <= TILE_SIZE + margin;
        if (!overlaps) {
          continue;
        }
        let path: Path2D;
        if (step.mode === "walk") {
          path = walkPath;
        } else if (step.mode === "ferry") {
          path = ferryPath;
        } else if (step.mode === "transfer") {
          path = transferPath;
        } else {
          const existing = ridePaths.get(step.mode.color);
          path = existing ?? new Path2D();
          ridePaths.set(step.mode.color, path);
        }
        path.moveTo(xs[0], ys[0]);
        for (let vertex = 1; vertex < count; vertex++) {
          path.lineTo(xs[vertex], ys[vertex]);
        }
      }

      context.globalAlpha = band.alpha;
      context.lineCap = "round";
      context.lineJoin = "round";
      context.lineWidth = width + CASING_EXTRA;
      context.strokeStyle = CASING_COLOR;
      context.stroke(walkPath);
      context.stroke(ferryPath);
      for (const path of ridePaths.values()) {
        context.stroke(path);
      }
      context.lineWidth = width;
      context.strokeStyle = band.color;
      context.stroke(walkPath);
      context.strokeStyle = FERRY_COLOR[currentTheme()];
      context.stroke(ferryPath);
      for (const [color, path] of ridePaths) {
        context.strokeStyle = color;
        context.stroke(path);
      }
      const dash = width * TRANSFER_WIDTH * TRANSFER_DASH;
      context.setLineDash([dash, dash]);
      context.lineWidth = width * TRANSFER_WIDTH + CASING_EXTRA;
      context.strokeStyle = CASING_COLOR;
      context.stroke(transferPath);
      context.lineWidth = width * TRANSFER_WIDTH;
      context.strokeStyle = band.color;
      context.stroke(transferPath);
      context.setLineDash([]);
      context.globalAlpha = 1;
    }
  }
}

// Thinned to a few hundred vertices, since this is hit-testing, not drawing.
function tapPositions(result: RouteResult): [number, number][] {
  const { lats, lngs } = result.path;
  const stride = Math.max(1, Math.ceil(lats.length / TAP_VERTICES));
  const positions: [number, number][] = [];
  for (let vertex = 0; vertex < lats.length; vertex += stride) {
    positions.push([lats[vertex], lngs[vertex]]);
  }
  const last = lats.length - 1;
  if (last >= 0) {
    positions.push([lats[last], lngs[last]]);
  }
  return positions;
}

interface RouteMark {
  positions: [number, number][];
  icon: L.DivIcon;
  color: string;
  label: string;
  dimmed: boolean;
  selected: boolean;
}

function badgeIcon(line: RouteLine): L.DivIcon {
  const opacity = line.selected && !line.dimmed ? 1 : ALT_ALPHA;
  return L.divIcon({
    className: "",
    html: `<span class="scenic-route-badge" style="background:${line.color};opacity:${opacity}">${line.label}</span>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

// Minted per color, not per stop: a trip calls at two or three and they all look the same.
const stationIcons = new Map<string, L.DivIcon>();
function stationIcon(color: string): L.DivIcon {
  const cached = stationIcons.get(color);
  if (cached) {
    return cached;
  }
  const icon = L.divIcon({
    className: "",
    html: `<span class="scenic-station-dot" style="border-color:${color}"></span>`,
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  });
  stationIcons.set(color, icon);
  return icon;
}

// Two opposed arrows on the route's slate, so a change reads apart from the line-colored stops.
const changeIcon = L.divIcon({
  className: "",
  html:
    '<span class="scenic-change-dot"><svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">' +
    '<path d="M2 5h10M9 2l3 3-3 3M14 11H4M7 8l-3 3 3 3" fill="none" stroke="#ffffff" stroke-width="1.8"' +
    ' stroke-linecap="round" stroke-linejoin="round"/></svg></span>',
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

function routeBounds(result: RouteResult): L.LatLngBounds {
  const { lats, lngs } = result.path;
  const bounds = L.latLngBounds([lats[0], lngs[0]], [lats[0], lngs[0]]);
  for (let vertex = 1; vertex < lats.length; vertex++) {
    bounds.extend([lats[vertex], lngs[vertex]]);
  }
  return bounds;
}
</script>

<script lang="ts">
interface RouteLayerProps {
  result: RouteResult | null;
  // Handed down, since the result lands before a city switch's new graph.
  graph: RoutingGraph | null;
  // Empty leaves `result` as the only line (Explorer's map).
  lines?: readonly RouteLine[];
  onSelectLine?: (index: number) => void;
  onHoverLine?: (index: number | null) => void;
  dest: { lat: number; lng: number } | null;
  // null keeps the green teardrop.
  markerColor: string | null;
  start: { lat: number; lng: number } | null;
  dragging: boolean;
  // Arrived from a shared link with its own camera, so the landing route doesn't reframe it away.
  preframedDest: { lat: number; lng: number } | null;
  // The destination `result` was asked for, which trails `dest` while a new search runs.
  routedTo: { lat: number; lng: number } | null;
  onDisengageFollow: () => void;
  // Each frame of a drag: re-routes without reverse-geocoding.
  onEndpointDragMove: (
    which: "start" | "dest",
    lat: number,
    lng: number,
  ) => void;
  // On drop: settles that end and reverse-geocodes its label.
  onEndpointDrag: (which: "start" | "dest", lat: number, lng: number) => void;
}

const {
  result,
  graph,
  markerColor,
  lines,
  onSelectLine,
  onHoverLine,
  dest,
  start,
  dragging,
  preframedDest,
  routedTo,
  onDisengageFollow,
  onEndpointDragMove,
  onEndpointDrag,
}: RouteLayerProps = $props();
const map = getMap();
const current = useCity();
const cityId = $derived(current().id);
let grid: RouteGrid | null = null;
const dropped = $derived(destIcon(markerColor));
// Fetched once the graph has rail; until the shapes land, a ride draws as the graph's chord.
let loaded = $state.raw<{ city: string; subway: Subway } | null>(null);
const rail = $derived((graph?.boardEdges.length ?? 0) > 0);
$effect(() => {
  // Held, so a late answer is filed under the city that asked.
  const requested = cityId;
  if (!rail) {
    return;
  }
  let live = true;
  loadSubwayTracks(requested)
    .then((subway) => {
      if (live) {
        loaded = { city: requested, subway };
      }
    })
    .catch((error: unknown) => {
      console.warn("subway tracks", error);
    });
  return () => {
    live = false;
  };
});
// Held by city, so a switch draws chords rather than the last city's track.
const tracks = $derived(loaded?.city === cityId ? loaded.subway : null);
// A slider recompute keeps the dest object's identity, so only a new destination reframes.
let framedDest: { lat: number; lng: number } | null = untrack(
  () => preframedDest,
);

onMount(() => {
  if (!map.getPane(PANE_NAME)) {
    const pane = map.createPane(PANE_NAME);
    pane.style.zIndex = String(PANE_Z_INDEX);
  }
  const created = new RouteGrid({
    pane: PANE_NAME,
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    keepBuffer: KEEP_BUFFER,
  });
  grid = created;
  created.addTo(map);
  return () => {
    created.remove();
    grid = null;
  };
});

// Keyed on the route, since a card tap passes a new `lines` array of the same routes.
const marks = new WeakMap<RouteResult, RouteMark>();
const markFor = (line: RouteLine): RouteMark => {
  const cached = marks.get(line.result);
  if (
    cached &&
    cached.color === line.color &&
    cached.label === line.label &&
    cached.dimmed === (line.dimmed ?? false) &&
    cached.selected === line.selected
  ) {
    return cached;
  }
  const fresh: RouteMark = {
    positions: tapPositions(line.result),
    icon: badgeIcon(line),
    color: line.color,
    label: line.label,
    dimmed: line.dimmed ?? false,
    selected: line.selected,
  };
  marks.set(line.result, fresh);
  return fresh;
};
// Thrown away when the track arrives, the one change to a route's look without a new route.
let drawings: {
  tracks: Subway | null;
  cache: WeakMap<RouteResult, RouteDrawing>;
} = { tracks: null, cache: new WeakMap() };
const drawingFor = (
  routeGraph: RoutingGraph,
  route: RouteResult,
): RouteDrawing => {
  if (drawings.tracks !== tracks) {
    drawings = { tracks, cache: new WeakMap() };
  }
  const cached = drawings.cache.get(route);
  if (cached) {
    return cached;
  }
  const fresh = buildDrawing(routeGraph, route, tracks);
  drawings.cache.set(route, fresh);
  return fresh;
};

const badgeFor = (line: RouteLine): { lat: number; lng: number } | null => {
  if (line.label === "") {
    return null;
  }
  return graph ? drawingFor(graph, line.result).badge : null;
};

const bands = $derived.by((): DrawBand[] => {
  if (!graph) {
    return [];
  } else if (lines && lines.length > 0) {
    return [...lines]
      .sort((left, right) => Number(left.selected) - Number(right.selected))
      .map((line) => ({
        steps: drawingFor(graph, line.result).steps,
        color: line.color,
        width: line.selected && !line.dimmed ? 1 : ALT_WIDTH,
        alpha: line.selected && !line.dimmed ? 1 : ALT_ALPHA,
      }));
  } else if (result) {
    return [
      {
        steps: drawingFor(graph, result).steps,
        color: ROUTE_COLOR,
        width: 1,
        alpha: 1,
      },
    ];
  } else {
    return [];
  }
});

// Only the chosen or hovered line gets station dots, since an alternative's are noise.
const drawn = $derived.by((): Pick<RouteDrawing, "stations" | "changes"> => {
  const highlighted = lines?.find((line) => line.selected)?.result ?? result;
  return graph && highlighted
    ? drawingFor(graph, highlighted)
    : { stations: [], changes: [] };
});

// Declared after the grid's mount, so the first bands find it on the map.
$effect(() => {
  grid?.setBands(bands);
});

// While dragging, a programmatic view change desyncs the pin from the cursor.
$effect(() => {
  if (!dest) {
    // Cleared, so the next destination reframes even if it lands on the same coordinates.
    framedDest = null;
    return;
  }
  if (!result) {
    return;
  }
  if (dragging) {
    framedDest = dest;
    return;
  }
  if (
    framedDest &&
    framedDest.lat === dest.lat &&
    framedDest.lng === dest.lng
  ) {
    return;
  }
  // The route still drawn answers the last destination; this one's is framed when it lands.
  if (!routedTo || routedTo.lat !== dest.lat || routedTo.lng !== dest.lng) {
    return;
  }
  framedDest = dest;
  const bounds = routeBounds(result);
  const padding: [number, number] = [64, 96];
  // Untracked, since Leaflet runs its move listeners inside these calls.
  untrack(() => {
    // Cut to another city, since an animated crossing draws this layer over open water.
    if (map.distance(bounds.getCenter(), map.getCenter()) > CROSS_CITY_METERS) {
      map.fitBounds(bounds, { padding, animate: false });
    } else {
      map.flyToBounds(bounds, { padding });
    }
    onDisengageFollow();
  });
});

// Out of the markup, where the formatter mangles a multi-line object.
const tapStyle = (line: RouteLine): L.PathOptions => ({
  color: line.color,
  weight: TAP_WIDTH,
  opacity: TAP_OPACITY,
});
const tapHandlers = (index: number): L.LeafletEventHandlerFnMap => ({
  click: () => onSelectLine?.(index),
  mouseover: () => onHoverLine?.(index),
  mouseout: () => onHoverLine?.(null),
});
const startHandlers: L.LeafletEventHandlerFnMap = {
  drag: (event) => {
    const { lat, lng } = event.target.getLatLng();
    onEndpointDragMove("start", lat, lng);
  },
  dragend: (event) => {
    const { lat, lng } = event.target.getLatLng();
    onEndpointDrag("start", lat, lng);
  },
};
const destHandlers: L.LeafletEventHandlerFnMap = {
  drag: (event) => {
    const { lat, lng } = event.target.getLatLng();
    onEndpointDragMove("dest", lat, lng);
  },
  dragend: (event) => {
    const { lat, lng } = event.target.getLatLng();
    onEndpointDrag("dest", lat, lng);
  },
};
const connector = (
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): [number, number][] => [
  [from.lat, from.lng],
  [to.lat, to.lng],
];

const snappedDest = $derived(result?.dest.point ?? null);
const showConnector = $derived(
  dest && snappedDest
    ? haversineMeters(dest.lat, dest.lng, snappedDest.lat, snappedDest.lng) >
        CONNECTOR_MIN_METERS
    : false,
);
</script>

{#snippet badgeMark(
  line: RouteLine,
  index: number,
  badge: { lat: number; lng: number } | null,
)}
  {#if badge}
    <Marker
      position={[badge.lat, badge.lng]}
      icon={markFor(line).icon}
      zIndexOffset={line.selected ? 900 : 800}
      eventHandlers={{ click: () => onSelectLine?.(index) }}
    />
  {/if}
{/snippet}

{#each lines ?? [] as line, index}
  {#if !line.selected}
    <Polyline
      positions={markFor(line).positions}
      interactive
      pathOptions={tapStyle(line)}
      eventHandlers={tapHandlers(index)}
    />
  {/if}
{/each}
{#each lines ?? [] as line, index}
  {@render badgeMark(line, index, badgeFor(line))}
{/each}
{#each drawn.stations as station}
  <!-- Under the route badge, over map marks. -->
  <Marker
    position={[station.lat, station.lng]}
    icon={stationIcon(station.color)}
    zIndexOffset={850}
    interactive={false}
  />
{/each}
{#each drawn.changes as change}
  <!-- Over the two platforms' dots it sits between. -->
  <Marker
    position={[change.lat, change.lng]}
    icon={changeIcon}
    zIndexOffset={860}
    interactive={false}
  />
{/each}
{#if start}
  <!-- zIndexOffset: above the live-location marker, which would otherwise swallow the drag. -->
  <Marker
    position={[start.lat, start.lng]}
    icon={startIcon}
    draggable
    autoPan
    autoPanPadding={DRAG_AUTOPAN_PADDING}
    zIndexOffset={1000}
    eventHandlers={startHandlers}
  />
{/if}
{#if dest}
  <Marker
    position={[dest.lat, dest.lng]}
    icon={dropped}
    draggable
    autoPan
    autoPanPadding={DRAG_AUTOPAN_PADDING}
    eventHandlers={destHandlers}
  />
{/if}
{#if showConnector && dest && snappedDest}
  <Polyline
    positions={connector(dest, snappedDest)}
    pathOptions={CONNECTOR_STYLE}
  />
{/if}
