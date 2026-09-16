"use client";

import L from "leaflet";
import { useEffect, useMemo, useRef, useState } from "react";
import { Marker, Polyline, useMap } from "react-leaflet";
import { CROSS_CITY_METERS } from "../src/cities";
import { FERRY_COLOR } from "../src/overlays/colors";
import type { RoutingGraph } from "../src/routing/graph";
import {
  buildDrawing,
  type DrawStep,
  type RouteDrawing,
  type StationDot,
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
import { destIcon, startIcon } from "./map-icons";

export interface RouteLine {
  result: RouteResult;
  color: string;
  label: string; // the card number, worn by the line and by the card; empty draws no badge
  selected: boolean;
  // This line answers the plan being replaced: it stays drawn, in the unselected style, until the
  // new one lands.
  dimmed?: boolean;
}

interface RouteLayerProps {
  result: RouteResult | null;
  // The graph `result` was computed against, handed down rather than fetched here. Both are edge
  // indices into one city's graph, and a layer that loads its own would draw a San Francisco route
  // through New York's edges for as long as the two disagreed — which is the whole span of a city
  // switch, since the result lands before the new fetch does.
  graph: RoutingGraph | null;
  // Every route on offer; empty leaves `result` as the only line, which is Explorer's map.
  lines?: readonly RouteLine[];
  onSelectLine?: (index: number) => void;
  // The line under the pointer, drawn as the chosen one is while it is; null on the way out.
  onHoverLine?: (index: number | null) => void;
  dest: { lat: number; lng: number } | null; // the tapped/searched destination
  // The colour the destination teardrop wears, from a deck with an accent; null keeps the green one.
  markerColor: string | null;
  start: { lat: number; lng: number } | null; // the snapped start, for the dot
  dragging: boolean; // an endpoint is being dragged; reframe zooms out only, never in
  // A destination that arrived from a shared link alongside its own camera, so the shared framing is
  // kept instead of being reframed away the moment the route lands.
  preframedDest: { lat: number; lng: number } | null;
  onDisengageFollow: () => void;
  // Live position of a dragged endpoint, each frame: re-routes without reverse-geocoding.
  onEndpointDragMove: (
    which: "start" | "dest",
    lat: number,
    lng: number,
  ) => void;
  // Drop of a dragged endpoint: settles that end and reverse-geocodes its label.
  onEndpointDrag: (which: "start" | "dest", lat: number, lng: number) => void;
}

const TILE_SIZE = 256;
const PANE_NAME = "route";
const PANE_Z_INDEX = 450; // above tiles (~200), below markers (~600)
const MIN_ZOOM = 3;
const MAX_ZOOM = 20;

// Keep a dragged endpoint this far from the viewport edge; Leaflet auto-pans the map to hold it there.
const DRAG_AUTOPAN_PADDING: [number, number] = [80, 80];

// The line reads as a route ribbon: ~4.5 px at z16, growing with zoom like the street layer, drawn
// as a neutral slate core inside a white casing. A neutral route reads clearly over the canopy — or
// any future overlay — without competing with its colour, and the white halo lifts it off the map.
const WIDTH_AT_Z16 = 4.5;
const WIDTH_PER_ZOOM = 1.3;
const MIN_WIDTH = 2.5;
const CASING_EXTRA = 3; // white halo, ~1.5 px each side

export const ROUTE_COLOR = "#334155"; // slate-700: a neutral route that reads over any overlay colour
const CASING_COLOR = "#ffffff";
const CONNECTOR_COLOR = "#94a3b8"; // slate-400
const CONNECTOR_MIN_METERS = 15; // draw the dashed tapped->snapped link only past this gap
// An unselected alternative: narrower and washed well back, but not gone. Its badge wears the same
// alpha as its line — a full-strength disc over a faint line reads as the route being highlighted.
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

  // Casing across every step of a band first, then the coloured lines, so the round joins meet
  // seamlessly rather than each step's casing overpainting its neighbour's fill. Bands paint in
  // order, so the selected line — last — lies over the rest.
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
      // One path per line ridden: a trip that changes trains is two colours, and each has to be
      // cased and stroked whole so its joins meet.
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
      context.globalAlpha = 1;
    }
  }
}

// Thinned to a few hundred vertices: this is hit-testing, not drawing, and a route carries thousands.
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

// What a route's geometry decides for the marks laid over it, worked out once per route.
interface RouteMark {
  positions: [number, number][];
  icon: L.DivIcon;
  color: string;
  label: string;
  dimmed: boolean;
  selected: boolean; // the badge is drawn back with its line, so a hover has to mint a new icon
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

// One white disc ringed in the line's colour, at a station the reader gets on, changes or gets off
// at. Minted per colour rather than per stop: a trip calls at two or three of them and they all
// look the same.
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

function routeBounds(result: RouteResult): L.LatLngBounds {
  const { lats, lngs } = result.path;
  const bounds = L.latLngBounds([lats[0], lngs[0]], [lats[0], lngs[0]]);
  for (let vertex = 1; vertex < lats.length; vertex++) {
    bounds.extend([lats[vertex], lngs[vertex]]);
  }
  return bounds;
}

export default function RouteLayer({
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
  onDisengageFollow,
  onEndpointDragMove,
  onEndpointDrag,
}: RouteLayerProps) {
  const map = useMap();
  const cityId = useCity().id;
  const gridRef = useRef<RouteGrid | null>(null);
  const dropped = useMemo(() => destIcon(markerColor), [markerColor]);
  // The agency's drawn track, fetched as soon as this layer has a graph that carries rail rather
  // than when a plan first rides one: a ride whose shapes have not landed is drawn as the chord the
  // graph carries, and waiting for the plan is waiting until there is a chord on the map to replace.
  // Where the shapes do not answer for a line at all, the chord is what stays.
  const [loaded, setLoaded] = useState<{ city: string; subway: Subway } | null>(
    null,
  );
  const rail = (graph?.boardEdges.length ?? 0) > 0;
  useEffect(() => {
    if (!rail) {
      return;
    }
    let live = true;
    loadSubwayTracks(cityId)
      .then((subway) => {
        if (live) {
          setLoaded({ city: cityId, subway });
        }
      })
      .catch((error: unknown) => {
        console.warn("subway tracks", error);
      });
    return () => {
      live = false;
    };
  }, [rail, cityId]);
  // Held by city, so a switch draws chords for the moment before the new city's shapes land rather
  // than projecting its stations onto the last city's track.
  const tracks = loaded?.city === cityId ? loaded.subway : null;
  // The dest object last framed by the camera; a slider recompute keeps its identity, a new
  // destination replaces it, so only the latter re-frames.
  const framedDest = useRef<{ lat: number; lng: number } | null>(preframedDest);

  useEffect(() => {
    if (!map.getPane(PANE_NAME)) {
      const pane = map.createPane(PANE_NAME);
      pane.style.zIndex = String(PANE_Z_INDEX);
    }
    const grid = new RouteGrid({
      pane: PANE_NAME,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      keepBuffer: KEEP_BUFFER,
    });
    gridRef.current = grid;
    grid.addTo(map);
    return () => {
      grid.remove();
      gridRef.current = null;
    };
  }, [map]);

  // Both caches are kept against the route itself: tapping a card hands this layer a new `lines`
  // array of the same routes, and re-decoding thousands of vertices — and minting new Leaflet icons
  // — to move a highlight is the whole cost of the gesture. A result belongs to one graph, so the
  // graph is not part of the key. Written during render, but only ever with what the route says.
  const marks = useRef(new WeakMap<RouteResult, RouteMark>());
  const markFor = (line: RouteLine): RouteMark => {
    const cached = marks.current.get(line.result);
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
    marks.current.set(line.result, fresh);
    return fresh;
  };
  // A drawing is thrown away wholesale when the track arrives, which is the one thing that changes
  // what a route looks like without the route itself changing.
  const drawings = useRef<{
    tracks: Subway | null;
    cache: WeakMap<RouteResult, RouteDrawing>;
  }>({ tracks: null, cache: new WeakMap() });
  const drawingFor = (
    routeGraph: RoutingGraph,
    route: RouteResult,
  ): RouteDrawing => {
    if (drawings.current.tracks !== tracks) {
      drawings.current = { tracks, cache: new WeakMap() };
    }
    const cached = drawings.current.cache.get(route);
    if (cached) {
      return cached;
    }
    const fresh = buildDrawing(routeGraph, route, tracks);
    drawings.current.cache.set(route, fresh);
    return fresh;
  };

  // The deck's own lines when it has them, otherwise the single route.
  // biome-ignore lint/correctness/useExhaustiveDependencies: drawingFor reads only its arguments
  const bands = useMemo(() => {
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
  }, [graph, result, lines, tracks]);

  // The dots belong to the line the reader is looking at: the chosen card, or the one the pointer is
  // over while they are all drawn. An alternative's stations are noise on a map of three routes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: drawingFor reads only its arguments
  const stations = useMemo<StationDot[]>(() => {
    if (!graph) {
      return [];
    }
    const highlighted = lines?.find((line) => line.selected)?.result ?? result;
    return highlighted ? drawingFor(graph, highlighted).stations : [];
  }, [graph, result, lines, tracks]);

  useEffect(() => {
    gridRef.current?.setBands(bands);
  }, [bands]);

  // Frame a fresh destination once its route lands; slider recomputes leave the camera alone. While an
  // endpoint is dragged we leave the camera to the marker's own autoPan (below) — any programmatic
  // view change mid-drag desyncs the pin from the cursor — and just remember the dest so releasing the
  // drag doesn't snap-reframe the settled route.
  useEffect(() => {
    if (!dest) {
      // Cleared, so the next destination reframes even if it lands on the same coordinates.
      framedDest.current = null;
      return;
    }
    if (!result) {
      return;
    }
    if (dragging) {
      framedDest.current = dest;
      return;
    }
    if (
      framedDest.current &&
      framedDest.current.lat === dest.lat &&
      framedDest.current.lng === dest.lng
    ) {
      return;
    }
    framedDest.current = dest;
    const bounds = routeBounds(result);
    const padding: [number, number] = [64, 96];
    // A route in the city on screen is flown to; one a city away is cut to, for the reason
    // CROSS_CITY_METERS carries — an animated crossing draws this very layer over open water for the
    // length of it. This is the third camera that can cross a city, after the explicit target and the
    // follow centring, and it is the one a shared link reaches first.
    if (map.distance(bounds.getCenter(), map.getCenter()) > CROSS_CITY_METERS) {
      map.fitBounds(bounds, { padding, animate: false });
    } else {
      map.flyToBounds(bounds, { padding });
    }
    onDisengageFollow();
  }, [result, dest, map, dragging, onDisengageFollow]);

  const snappedDest = result?.dest.point ?? null;
  const showConnector =
    dest && snappedDest
      ? haversineMeters(dest.lat, dest.lng, snappedDest.lat, snappedDest.lng) >
        CONNECTOR_MIN_METERS
      : false;

  return (
    <>
      {lines?.map((line, index) =>
        line.selected ? null : (
          <Polyline
            // biome-ignore lint/suspicious/noArrayIndexKey: the deck's order IS a line's identity
            key={index}
            positions={markFor(line).positions}
            interactive
            pathOptions={{
              color: line.color,
              weight: TAP_WIDTH,
              opacity: TAP_OPACITY,
            }}
            eventHandlers={{
              click: () => onSelectLine?.(index),
              mouseover: () => onHoverLine?.(index),
              mouseout: () => onHoverLine?.(null),
            }}
          />
        ),
      )}
      {lines?.map((line, index) => {
        if (line.label === "") {
          return null; // a chosen route is the only one drawn, and a badge would number a set of one
        }
        const badge = graph ? drawingFor(graph, line.result).badge : null;
        return badge ? (
          <Marker
            // biome-ignore lint/suspicious/noArrayIndexKey: the deck's order IS a line's identity
            key={`badge-${index}`}
            position={[badge.lat, badge.lng]}
            icon={markFor(line).icon}
            zIndexOffset={line.selected ? 900 : 800}
            eventHandlers={{ click: () => onSelectLine?.(index) }}
          />
        ) : null;
      })}
      {stations.map((station, index) => (
        <Marker
          // biome-ignore lint/suspicious/noArrayIndexKey: the order IS a dot's identity, and a transfer's two dots can share a platform's coordinates
          key={`station-${index}`}
          position={[station.lat, station.lng]}
          icon={stationIcon(station.color)}
          zIndexOffset={850} // under the route badge, over everything the map draws itself
          interactive={false}
        />
      ))}
      {start ? (
        <Marker
          position={[start.lat, start.lng]}
          icon={startIcon}
          draggable
          autoPan
          autoPanPadding={DRAG_AUTOPAN_PADDING}
          // Above the live-location marker (which renders later at the same spot) so the start always
          // owns the drag gesture; otherwise the location marker can swallow it and strand the drag.
          zIndexOffset={1000}
          eventHandlers={{
            drag: (event) => {
              const { lat, lng } = event.target.getLatLng();
              onEndpointDragMove("start", lat, lng);
            },
            dragend: (event) => {
              const { lat, lng } = event.target.getLatLng();
              onEndpointDrag("start", lat, lng);
            },
          }}
        />
      ) : null}
      {dest ? (
        <Marker
          position={[dest.lat, dest.lng]}
          icon={dropped}
          draggable
          autoPan
          autoPanPadding={DRAG_AUTOPAN_PADDING}
          eventHandlers={{
            drag: (event) => {
              const { lat, lng } = event.target.getLatLng();
              onEndpointDragMove("dest", lat, lng);
            },
            dragend: (event) => {
              const { lat, lng } = event.target.getLatLng();
              onEndpointDrag("dest", lat, lng);
            },
          }}
        />
      ) : null}
      {showConnector && dest && snappedDest ? (
        <Polyline
          positions={[
            [dest.lat, dest.lng],
            [snappedDest.lat, snappedDest.lng],
          ]}
          pathOptions={{
            color: CONNECTOR_COLOR,
            weight: 2,
            dashArray: "4 5",
          }}
        />
      ) : null}
    </>
  );
}
