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

// Every grid layer on the map inherits this, so it goes in once here rather than in each layer.
installTilePrune();

export interface MapTarget {
  lat: number;
  lng: number;
  zoom?: number;
}

// A place found in the search panel and left on the map. One at a time, and no route of its own.
export interface SearchPin {
  lat: number;
  lng: number;
  label: string;
}

interface MapViewProps {
  city: City; // frames the map when there is no camera to restore
  pins: Pin[];
  draft: PinDraft | null;
  target: MapTarget | null;
  userLocation: { lat: number; lng: number } | null;
  following: boolean;
  activeOverlays: ReadonlySet<OverlayId>;
  routeResult: RouteResult | null;
  routeGraph: RoutingGraph | null; // the graph routeResult's edge indices point into
  // Every route a deck is offering at once, drawn together; empty leaves routeResult the only line.
  routeLines: readonly RouteLine[] | undefined;
  onSelectLine: ((index: number) => void) | undefined;
  onHoverLine: ((index: number | null) => void) | undefined;
  routeDest: { lat: number; lng: number } | null;
  routeStart: { lat: number; lng: number } | null;
  searchPin: SearchPin | null;
  // The color the dropped pins wear, from the deck that has an accent; null keeps the app's green.
  markerColor: string | null;
  // A field has armed the next tap to set its point. Nothing else makes a tap place anything.
  picking: boolean;
  dragging: boolean; // an endpoint marker is being dragged; the route reframe goes zoom-out-only
  initialCamera: Camera | null; // a shared link's camera, applied once; null leaves the map alone
  preframedDest: { lat: number; lng: number } | null; // a dest whose framing the link already chose
  // The settled camera, plus what it can see: the visible bounds pick the active city when only one
  // city is on screen, which the center alone cannot tell.
  onCamera: (camera: Camera, view: CityBounds) => void;
  // The basemap could not be fetched, so the map has no streets under the overlays. It has no row in
  // the layers menu to badge, so the app says it in the banner instead.
  onBasemapLost: (lost: boolean) => void;
  onMapPick: (lat: number, lng: number) => void;
  onDisengageFollow: () => void;
  onEndpointDragMove: (
    which: "start" | "dest",
    lat: number,
    lng: number,
  ) => void;
  onEndpointDrag: (which: "start" | "dest", lat: number, lng: number) => void;
  // The found place moved by dragging its pin: the same act as tapping the map somewhere else, so it
  // renames the place and leaves the deck asking whether to walk there.
  onSearchPinDrag: (lat: number, lng: number) => void;
  onPinSelect: (pin: Pin) => void;
}

// Keep a dragged pin this far from the viewport edge, as a dragged endpoint is kept.
const SEARCH_PIN_AUTOPAN: [number, number] = [80, 80];

const draftIcon = L.divIcon({
  className: "",
  html: '<div class="scenic-draft-pin"><div class="scenic-draft-pin-ring"></div><div class="scenic-draft-pin-dot"></div></div>',
  iconSize: [28, 28],
  iconAnchor: [14, 14],
});

// A map click sets the armed field's location. Mounted only while a field has armed pick mode, so
// ordinary browsing never intercepts clicks; pin markers stop propagation, so they still select.
// react-leaflet freezes MapContainer's className at mount, so the crosshair is set on the live
// container instead of being handed down as a prop.
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

// Leaflet 1.9 dropped its touch `tap` handler, so this restores double-tap zoom and adds Android's
// quick zoom: hold the second tap and drag, down to zoom in. The drag mirrors Map.TouchZoom, hence
// the private calls. preventDefault on the second tap suppresses the browser's own double-tap zoom
// and the synthesised dblclick.
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP = 40; // px between the two taps
const TAP_MOVE_SLOP = 12; // px a tap may drift and still count as a tap rather than a drag
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
    let start: L.Point | null = null; // null when the touch began somewhere we must not zoom from
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

    // no-op unless a quick zoom ran, in which case it settles on an integer zoom
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
        end(); // pinch is taking over; don't leave our move dangling
        lastTap = null;
      } else {
        const [touch] = event.touches;
        // a draggable marker has its own Draggable, which map.dragging doesn't cover, so zooming
        // from a route endpoint would drag the pin at the same time
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
            // Both mobile browsers ship double-tap-and-drag as a page zoom of their own and commit
            // to it here unless the second tap is prevented; once committed they never hand it
            // back. Only ours to claim when we zoom instead, and only on the second tap: a first
            // tap keeps its synthesised click, which the pick flow runs on.
            event.preventDefault();
          }
          // while following, anchor on the center so the zoom can't drift off the user
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
      // every move of an armed gesture, the slop window included: leaving even the first few
      // unprevented is enough for the browser to start its own double-tap-drag page zoom
      event.preventDefault();
      const [touch] = event.touches;
      if (!zoomFrom) {
        // beat Leaflet's Draggable to its own 3px tolerance — ours is on the container, its on the
        // document — so nothing pans and no dragstart fires to disengage follow
        if (!dragSuspended) {
          dragSuspended = true;
          // dragging.disable() drops leaflet-touch-drag, and with it the container's
          // `touch-action: none`, exactly as the drag starts; an inline value outranks the class
          // rules and comes back off in reset()
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
      // bounceAtZoomLimits is off, so clamp; _limitZoom would snap mid-gesture
      const zoom = Math.max(
        map.getMinZoom(),
        Math.min(map.getMaxZoom(), target),
      );
      // offset the anchor's projected position so it stays under the pixel it was tapped at
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
          // suppressing the browser's own double-tap zoom is only ours to do when we zoom instead
          event.preventDefault();
          map.setZoomAround(tapped.latLng, map.getZoom() + 1, {
            animate: true,
          });
        }
      } else if (fingers > 1 || event.changedTouches.length !== 1) {
        // only a clean single-finger tap counts — not the lift-off of a pinch or a drag
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
      // end, not reset: a prop change mid-drag would otherwise strand the map on the gesture's
      // fractional zoom, which MapController then carries into every later flyTo
      end();
    };
  }, [map, following, picking]);
  return null;
}

// Reports the camera after every settled move so the share link can capture it, and applies a shared
// link's camera once. The hash is read in an effect, so the camera arrives as a prop rather than as the
// container's initial center — hence setView here rather than a MapContainer prop.
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

  // fly to an explicit target (e.g. a selected saved pin)
  useEffect(() => {
    if (!target) {
      // clear the key so re-selecting the same target (e.g. after closing the editor) still flies
      lastTargetKey.current = "";
      return;
    }
    const key = `${target.lat},${target.lng},${target.zoom ?? ""}`;
    if (key === lastTargetKey.current) {
      return;
    }
    lastTargetKey.current = key;
    const zoom = target.zoom ?? map.getZoom();
    // A short hop is animated, a cross-city one is cut; CROSS_CITY_METERS carries why.
    if (
      map.distance([target.lat, target.lng], map.getCenter()) >
      CROSS_CITY_METERS
    ) {
      map.setView([target.lat, target.lng], zoom, { animate: false });
    } else {
      map.flyTo([target.lat, target.lng], zoom, { duration: 0.8 });
    }
  }, [target, map]);

  // follow camera: recenter on the user while engaged
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
      // first fix: zoom in to street level, cutting rather than flying when the map opened on a
      // different city than the one you turn out to be in — CROSS_CITY_METERS carries why.
      hasZoomedRef.current = true;
      if (crossCity) {
        map.setView([lat, lng], 16, { animate: false });
      } else {
        map.flyTo([lat, lng], 16, { duration: 0.8 });
      }
    } else if (justEngaged) {
      // re-engaged: snap back at the current zoom, cutting if that means crossing to another city —
      // reachable by panning to the other city and then tapping follow.
      if (crossCity) {
        map.setView([lat, lng], map.getZoom(), { animate: false });
      } else {
        map.flyTo([lat, lng], map.getZoom(), { duration: 0.8 });
      }
    } else {
      // steady state: pan to the user, keeping their zoom
      map.setView([lat, lng], map.getZoom(), { animate: true });
    }
  }, [following, userLocation, map]);

  // while following, anchor zoom on the map center (the user) not the cursor, so it doesn't drift off them
  useEffect(() => {
    const zoomAnchor = following ? "center" : true;
    map.options.scrollWheelZoom = zoomAnchor;
    map.options.doubleClickZoom = zoomAnchor;
    map.options.touchZoom = zoomAnchor;
  }, [following, map]);

  // only a pan (dragstart) releases follow; programmatic flyTo/setView don't fire dragstart, so any dragstart is a real user grab
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
  // Rebuilt only when the theme flips, and handed to the marker as a new icon so it repaints in
  // place: an icon built once at import keeps its old gradient until something remounts the marker.
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
      {/* every active overlay's Leaflet layers, from the registry; nothing when the set is empty */}
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
        // Nothing to tap — the name is in the search panel that found it, and the panel is where the
        // pin is cleared — but it drags, as the destination does: a place found in roughly the right
        // spot is moved by pulling it, not by tapping the map again and hoping.
        //
        // A draggable marker is interactive, and Leaflet stops an interactive marker's clicks at the
        // marker: an armed "pick on the map" tap that landed on the pin did nothing at all. Bubbling
        // hands the tap to the map, which is the one flow that arms, defers and cancels a pick.
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
