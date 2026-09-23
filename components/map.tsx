"use client";

import L from "leaflet";
import { Fragment, useEffect, useMemo, useRef } from "react";
import {
  AttributionControl,
  MapContainer,
  Marker,
  Tooltip,
  useMap,
  useMapEvents,
} from "react-leaflet";
import {
  CITY_ZOOM,
  type City,
  type CityBounds,
  CROSS_CITY_METERS,
} from "../src/cities";
import { OVERLAYS, type OverlayId } from "../src/overlays/registry";
import type { Pin, PinDraft } from "../src/pin";
import type { RoutingGraph } from "../src/routing/graph";
import type { RouteResult } from "../src/routing/search";
import installTilePrune from "../src/tiles/prune";
import type { Camera } from "../src/url-state";
import Basemap from "./basemap";
import { savedIcon, searchIcon, userIcon } from "./map-icons";
import RouteLayer, { type RouteLine } from "./route-layer";
import { useMapTheme } from "./use-map-theme";

// Patches every grid layer on the map, so it runs once here.
installTilePrune();

export interface MapTarget {
  lat: number;
  lng: number;
  zoom?: number;
}

export interface SearchPin {
  lat: number;
  lng: number;
  label: string;
}

interface MapViewProps {
  city: City;
  pins: Pin[];
  draft: PinDraft | null;
  target: MapTarget | null;
  userLocation: { lat: number; lng: number } | null;
  following: boolean;
  activeOverlays: ReadonlySet<OverlayId>;
  routeResult: RouteResult | null;
  routeGraph: RoutingGraph | null;
  routeLines: readonly RouteLine[] | undefined;
  onSelectLine: ((index: number) => void) | undefined;
  onHoverLine: ((index: number | null) => void) | undefined;
  routeDest: { lat: number; lng: number } | null;
  routeStart: { lat: number; lng: number } | null;
  searchPin: SearchPin | null;
  // null keeps the app's green.
  markerColor: string | null;
  // A field has armed the next tap to set its point; nothing else makes a tap place anything.
  picking: boolean;
  dragging: boolean;
  initialCamera: Camera | null;
  preframedDest: { lat: number; lng: number } | null;
  // The visible bounds pick the active city when only one is on screen.
  onCamera: (camera: Camera, view: CityBounds) => void;
  onBasemapLost: (lost: boolean) => void;
  onMapPick: (lat: number, lng: number) => void;
  onDisengageFollow: () => void;
  onEndpointDragMove: (
    which: "start" | "dest",
    lat: number,
    lng: number,
  ) => void;
  onEndpointDrag: (which: "start" | "dest", lat: number, lng: number) => void;
  // The same as tapping the map elsewhere: it renames the place.
  onSearchPinDrag: (lat: number, lng: number) => void;
  onPinSelect: (pin: Pin) => void;
}

// px from the viewport edge, as for a dragged endpoint.
const SEARCH_PIN_AUTOPAN: [number, number] = [80, 80];

const draftIcon = L.divIcon({
  className: "",
  html: '<div class="scenic-draft-pin"><div class="scenic-draft-pin-ring"></div><div class="scenic-draft-pin-dot"></div></div>',
  iconSize: [28, 28],
  iconAnchor: [14, 14],
});

// react-leaflet freezes MapContainer's className at mount, so the crosshair goes on the container.
function PickCursor({ picking }: { picking: boolean }) {
  const map = useMap();
  useEffect(() => {
    const container = map.getContainer();
    container.classList.toggle("scenic-picking", picking);
    return () => container.classList.remove("scenic-picking");
  }, [map, picking]);
  return null;
}

function PickCatcher({
  onMapPick,
}: {
  onMapPick: (lat: number, lng: number) => void;
}) {
  useMapEvents({
    click: (event) => {
      onMapPick(event.latlng.lat, event.latlng.lng);
    },
  });
  return null;
}

// Leaflet's private zoom plumbing, which @types/leaflet doesn't expose.
interface MapZoomInternals {
  _stop(): void;
  _move(
    center: L.LatLng,
    zoom: number,
    data: { pinch: boolean; round: boolean },
  ): void;
  _animateZoom(
    center: L.LatLng,
    zoom: number,
    startAnim: boolean,
    noUpdate: number | boolean,
  ): void;
  _limitZoom(zoom: number): number;
}

// Leaflet 1.9 dropped its touch `tap` handler, so this restores double-tap zoom and quick zoom.
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP = 40; // px between the two taps
const TAP_MOVE_SLOP = 12; // px a tap may drift
const ZOOM_PX_PER_LEVEL = 128; // matching MapLibre's quick zoom

function DoubleTapZoom({
  following,
  picking,
}: {
  following: boolean;
  picking: boolean;
}) {
  const map = useMap();
  useEffect(() => {
    const container = map.getContainer();
    const internals = map as unknown as MapZoomInternals;
    let lastTap: { time: number; at: L.Point } | null = null;
    let start: L.Point | null = null;
    let fingers = 0;
    let armed = false;
    let dragSuspended = false;
    let anchor: { latLng: L.LatLng; at: L.Point } | null = null;
    let zoomFrom: { zoom: number; clientY: number } | null = null;
    let gesture: { zoom: number; center: L.LatLng } | null = null;
    let animFrame: number | undefined;
    let priorTouchAction = "";

    const screenPoint = ({ clientX, clientY }: Touch): L.Point =>
      L.point(clientX, clientY);

    const containerPoint = (touch: Touch): L.Point => {
      const { left, top } = container.getBoundingClientRect();
      return screenPoint(touch).subtract(L.point(left, top));
    };

    const reset = () => {
      armed = false;
      anchor = null;
      zoomFrom = null;
      gesture = null;
      if (animFrame !== undefined) {
        L.Util.cancelAnimFrame(animFrame);
        animFrame = undefined;
      }
      if (dragSuspended) {
        dragSuspended = false;
        container.style.touchAction = priorTouchAction;
        map.dragging.enable();
      }
    };

    // No-op unless a quick zoom ran, in which case it settles on an integer zoom.
    const end = () => {
      const settled = gesture;
      reset();
      if (settled) {
        const { center } = settled;
        const zoom = internals._limitZoom(settled.zoom);
        if (map.options.zoomAnimation) {
          internals._animateZoom(center, zoom, true, map.options.zoomSnap ?? 1);
        } else {
          map.setView(center, zoom, { animate: false });
        }
      }
    };

    const onStart = (event: TouchEvent) => {
      fingers = event.touches.length;
      if (fingers !== 1) {
        end();
        lastTap = null;
      } else {
        const [touch] = event.touches;
        // A draggable marker has its own Draggable, so zooming from an endpoint would drag the pin.
        const onMarker =
          touch.target instanceof Element &&
          touch.target.closest(".leaflet-marker-draggable") !== null;
        start = onMarker ? null : screenPoint(touch);
        if (
          start &&
          lastTap &&
          event.timeStamp - lastTap.time < DOUBLE_TAP_MS &&
          start.distanceTo(lastTap.at) < DOUBLE_TAP_SLOP
        ) {
          lastTap = null;
          armed = true;
          if (!picking) {
            // Otherwise mobile browsers commit to their own double-tap-drag page zoom.
            event.preventDefault();
          }
          // While following, anchor on the center so the zoom can't drift off the user.
          const at = following
            ? map.getSize().divideBy(2)
            : containerPoint(touch);
          anchor = { at, latLng: map.containerPointToLatLng(at) };
        }
      }
    };

    const onMove = (event: TouchEvent) => {
      if (
        !armed ||
        picking ||
        !anchor ||
        !start ||
        event.touches.length !== 1
      ) {
        return;
      }
      // Any unprevented move lets the browser start its own page zoom.
      event.preventDefault();
      const [touch] = event.touches;
      if (!zoomFrom) {
        // Beat Leaflet's Draggable to its 3px tolerance, so nothing pans and follow stays on.
        if (!dragSuspended) {
          dragSuspended = true;
          // dragging.disable() drops the class setting `touch-action: none`; cleared in reset().
          priorTouchAction = container.style.touchAction;
          container.style.touchAction = "none";
          map.dragging.disable();
        }
        if (screenPoint(touch).distanceTo(start) <= TAP_MOVE_SLOP) {
          return;
        }
        zoomFrom = { zoom: map.getZoom(), clientY: touch.clientY };
        internals._stop();
        map.fire("zoomstart").fire("movestart");
      }
      const target =
        zoomFrom.zoom + (touch.clientY - zoomFrom.clientY) / ZOOM_PX_PER_LEVEL;
      // bounceAtZoomLimits is off, so clamp; _limitZoom would snap mid-gesture.
      const zoom = Math.max(
        map.getMinZoom(),
        Math.min(map.getMaxZoom(), target),
      );
      // Offset the anchor's projected position so it stays under the pixel it was tapped at.
      const center = map.unproject(
        map
          .project(anchor.latLng, zoom)
          .subtract(anchor.at.subtract(map.getSize().divideBy(2))),
        zoom,
      );
      gesture = { zoom, center };
      if (animFrame !== undefined) {
        L.Util.cancelAnimFrame(animFrame);
      }
      animFrame = L.Util.requestAnimFrame(
        () => {
          internals._move(center, zoom, { pinch: true, round: false });
        },
        undefined,
        true,
      );
    };

    const onEnd = (event: TouchEvent) => {
      if (zoomFrom) {
        event.preventDefault();
        end();
        lastTap = null;
      } else if (armed) {
        const tapped = anchor;
        end();
        lastTap = null;
        if (tapped && !picking) {
          // Suppressing the browser's double-tap zoom is ours to do only when we zoom instead.
          event.preventDefault();
          map.setZoomAround(tapped.latLng, map.getZoom() + 1, {
            animate: true,
          });
        }
      } else if (fingers > 1 || event.changedTouches.length !== 1) {
        // Only a clean single-finger tap counts, not the lift-off of a pinch or a drag.
        lastTap = null;
      } else {
        const [touch] = event.changedTouches;
        const at = screenPoint(touch);
        lastTap =
          start && at.distanceTo(start) <= TAP_MOVE_SLOP
            ? { time: event.timeStamp, at }
            : null;
      }
    };

    const onCancel = () => {
      end();
      lastTap = null;
    };

    container.addEventListener("touchstart", onStart, { passive: false });
    container.addEventListener("touchmove", onMove, { passive: false });
    container.addEventListener("touchend", onEnd, { passive: false });
    container.addEventListener("touchcancel", onCancel, { passive: true });
    return () => {
      container.removeEventListener("touchstart", onStart);
      container.removeEventListener("touchmove", onMove);
      container.removeEventListener("touchend", onEnd);
      container.removeEventListener("touchcancel", onCancel);
      // end, not reset, or a mid-drag prop change leaves a fractional zoom for later flyTo calls.
      end();
    };
  }, [map, following, picking]);
  return null;
}

// The hash is read in an effect, so a shared camera arrives as a prop after mount.
function CameraWatcher({
  initial,
  onCamera,
}: {
  initial: Camera | null;
  onCamera: (camera: Camera, view: CityBounds) => void;
}) {
  const map = useMap();
  const appliedRef = useRef<boolean>(false);

  useEffect(() => {
    const report = () => {
      const { lat, lng } = map.getCenter();
      const view = map.getBounds();
      onCamera(
        { center: { lat, lng }, zoom: map.getZoom() },
        {
          south: view.getSouth(),
          west: view.getWest(),
          north: view.getNorth(),
          east: view.getEast(),
        },
      );
    };
    if (initial && !appliedRef.current) {
      appliedRef.current = true;
      map.setView([initial.center.lat, initial.center.lng], initial.zoom, {
        animate: false,
      });
    }
    report();
    map.on("moveend", report);
    return () => {
      map.off("moveend", report);
    };
  }, [initial, map, onCamera]);

  return null;
}

interface MapControllerProps {
  target: MapTarget | null;
  following: boolean;
  userLocation: { lat: number; lng: number } | null;
  onDisengageFollow: () => void;
}

function MapController({
  target,
  following,
  userLocation,
  onDisengageFollow,
}: MapControllerProps) {
  const map = useMap();
  const lastTargetKey = useRef<string>("");
  const hasZoomedRef = useRef<boolean>(false);
  const wasFollowingRef = useRef<boolean>(following);

  useEffect(() => {
    if (!target) {
      // Clear the key so re-selecting the same target still flies.
      lastTargetKey.current = "";
      return;
    }
    const key = `${target.lat},${target.lng},${target.zoom ?? ""}`;
    if (key === lastTargetKey.current) {
      return;
    }
    lastTargetKey.current = key;
    const zoom = target.zoom ?? map.getZoom();
    // A cross-city hop is cut, since an animated crossing draws layers over open water.
    if (
      map.distance([target.lat, target.lng], map.getCenter()) >
      CROSS_CITY_METERS
    ) {
      map.setView([target.lat, target.lng], zoom, { animate: false });
    } else {
      map.flyTo([target.lat, target.lng], zoom, { duration: 0.8 });
    }
  }, [target, map]);

  useEffect(() => {
    const justEngaged = following && !wasFollowingRef.current;
    wasFollowingRef.current = following;
    if (!following || !userLocation) {
      return;
    }
    const { lat, lng } = userLocation;
    const crossCity =
      map.distance([lat, lng], map.getCenter()) > CROSS_CITY_METERS;
    if (!hasZoomedRef.current) {
      // First fix: zoom to street level, cutting rather than flying to a different city.
      hasZoomedRef.current = true;
      if (crossCity) {
        map.setView([lat, lng], 16, { animate: false });
      } else {
        map.flyTo([lat, lng], 16, { duration: 0.8 });
      }
    } else if (justEngaged) {
      // Re-engaged: snap back at the current zoom, cutting if that crosses to another city.
      if (crossCity) {
        map.setView([lat, lng], map.getZoom(), { animate: false });
      } else {
        map.flyTo([lat, lng], map.getZoom(), { duration: 0.8 });
      }
    } else {
      map.setView([lat, lng], map.getZoom(), { animate: true });
    }
  }, [following, userLocation, map]);

  // While following, anchor zoom on the map center (the user), not the cursor.
  useEffect(() => {
    const zoomAnchor = following ? "center" : true;
    map.options.scrollWheelZoom = zoomAnchor;
    map.options.doubleClickZoom = zoomAnchor;
    map.options.touchZoom = zoomAnchor;
  }, [following, map]);

  // Programmatic flyTo/setView fire no dragstart, so any dragstart is a real user grab.
  useEffect(() => {
    const handleDragStart = () => {
      onDisengageFollow();
    };
    map.on("dragstart", handleDragStart);
    return () => {
      map.off("dragstart", handleDragStart);
    };
  }, [map, onDisengageFollow]);

  return null;
}

function summarizePin(pin: Pin): string {
  const note = pin.text.trim();
  if (note) {
    return note;
  }
  return pin.address;
}

export default function MapView({
  onBasemapLost,
  city,
  pins,
  draft,
  target,
  userLocation,
  following,
  activeOverlays,
  routeResult,
  routeGraph,
  routeLines,
  onSelectLine,
  onHoverLine,
  routeDest,
  routeStart,
  searchPin,
  onSearchPinDrag,
  markerColor,
  picking,
  dragging,
  initialCamera,
  preframedDest,
  onCamera,
  onMapPick,
  onDisengageFollow,
  onEndpointDragMove,
  onEndpointDrag,
  onPinSelect,
}: MapViewProps) {
  // Rebuilt on a theme flip, since an existing icon keeps its old gradient.
  const theme = useMapTheme();
  const searchMarker = useMemo(
    () => searchIcon(theme, markerColor),
    [theme, markerColor],
  );

  const markers = useMemo(
    () =>
      pins.map((pin) => (
        <Marker
          key={pin.id}
          position={[pin.lat, pin.lng]}
          icon={savedIcon}
          eventHandlers={{
            click: () => onPinSelect(pin),
          }}
        >
          <Tooltip
            direction="top"
            offset={[0, -8]}
            opacity={1}
            className="scenic-tooltip"
          >
            {summarizePin(pin)}
          </Tooltip>
        </Marker>
      )),
    [pins, onPinSelect],
  );

  return (
    <MapContainer
      center={[city.center.lat, city.center.lng]}
      zoom={CITY_ZOOM}
      className="h-dvh w-full"
      zoomControl={false}
      bounceAtZoomLimits={false}
      attributionControl={false}
    >
      {/* The full source list lives in About; the corner carries only the basemap credit. */}
      <AttributionControl prefix={false} />
      <Basemap onLost={onBasemapLost} />
      {OVERLAYS.filter((overlay) => activeOverlays.has(overlay.id)).map(
        (overlay) => (
          <Fragment key={overlay.id}>{overlay.render()}</Fragment>
        ),
      )}
      <CameraWatcher initial={initialCamera} onCamera={onCamera} />
      <MapController
        target={target}
        following={following}
        userLocation={userLocation}
        onDisengageFollow={onDisengageFollow}
      />
      <RouteLayer
        result={routeResult}
        graph={routeGraph}
        markerColor={markerColor}
        lines={routeLines}
        onSelectLine={onSelectLine}
        onHoverLine={onHoverLine}
        dest={routeDest}
        start={routeStart}
        dragging={dragging}
        preframedDest={preframedDest}
        onDisengageFollow={onDisengageFollow}
        onEndpointDragMove={onEndpointDragMove}
        onEndpointDrag={onEndpointDrag}
      />
      <PickCursor picking={picking} />
      {picking ? <PickCatcher onMapPick={onMapPick} /> : null}
      <DoubleTapZoom following={following} picking={picking} />
      {markers}
      {userLocation ? (
        <Marker
          position={[userLocation.lat, userLocation.lng]}
          icon={userIcon}
        />
      ) : null}
      {draft ? (
        <Marker position={[draft.lat, draft.lng]} icon={draftIcon} />
      ) : null}
      {searchPin ? (
        // Leaflet stops a draggable marker's clicks; bubbling hands an armed pick tap to the map.
        <Marker
          position={[searchPin.lat, searchPin.lng]}
          icon={searchMarker}
          draggable
          bubblingMouseEvents
          autoPan
          autoPanPadding={SEARCH_PIN_AUTOPAN}
          eventHandlers={{
            dragend: (event) => {
              const { lat, lng } = event.target.getLatLng();
              onSearchPinDrag(lat, lng);
            },
          }}
        />
      ) : null}
    </MapContainer>
  );
}
