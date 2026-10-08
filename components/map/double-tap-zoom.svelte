<script module lang="ts">
import L from "leaflet";
import { getMap } from "../map-context";

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
</script>

<script lang="ts">
interface Props {
  following: boolean;
  picking: boolean;
}

const props: Props = $props();
const map = getMap();

$effect(() => {
  // Read here, so a change of either ends the gesture in flight and starts afresh.
  const { following, picking } = props;
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
    if (!armed || picking || !anchor || !start || event.touches.length !== 1) {
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
    const zoom = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), target));
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
});
</script>
