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
  label: string;
  selected: boolean;
  // Stays drawn, unselected, until the new plan lands.
  dimmed?: boolean;
}

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

export const ROUTE_COLOR = "#334155"; // slate-700
const CASING_COLOR = "#ffffff";
const CONNECTOR_COLOR = "#94a3b8"; // slate-400
const CONNECTOR_MIN_METERS = 15;
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
  // Fetched once the graph has rail; until the shapes land, a ride draws as the graph's chord.
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
  // Held by city, so a switch draws chords rather than the last city's track.
  const tracks = loaded?.city === cityId ? loaded.subway : null;
  // A slider recompute keeps the dest object's identity, so only a new destination reframes.
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

  // Keyed on the route, since a card tap passes a new `lines` array of the same routes.
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
  // Thrown away when the track arrives, the one change to a route's look without a new route.
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

  // Only the chosen or hovered line gets station dots, since an alternative's are noise.
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

  // While dragging, a programmatic view change desyncs the pin from the cursor.
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
    // Cut to another city, since an animated crossing draws this layer over open water.
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
          return null;
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
          // biome-ignore lint/suspicious/noArrayIndexKey: order is identity; coords repeat
          key={`station-${index}`}
          position={[station.lat, station.lng]}
          icon={stationIcon(station.color)}
          zIndexOffset={850} // under the route badge, over map marks
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
          // Above the live-location marker, which would otherwise swallow the drag.
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
