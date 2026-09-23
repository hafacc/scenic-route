"use client";

import { useEffect } from "react";
import { useMap } from "react-leaflet";
import * as SunCalc from "suncalc";
import { activeCity } from "../src/cities";
import { reportLayerData, watchLayerStatus } from "../src/overlays/status";
import {
  getResolvedDate,
  isPickerOpen,
  subscribeRouteTime,
} from "../src/route-time/store";
import { loadGraph } from "../src/routing/graph";
import { loadSheds, shedDay } from "../src/routing/sheds";
import { canopyTau } from "../src/shade/phenology";
import { declinationOf, hourAngleOf, seasonBand } from "../src/shade/sun";
import WorkerTileLayer, {
  prefetchShadeTiles,
  sendShedDecks,
} from "../src/tiles/layer";
import type { TileCoords } from "../src/tiles/protocol";
import { KEEP_BUFFER } from "../src/tiles/raster";
import { shedDecks } from "../src/tiles/shed-decks";
import { useCity } from "./city-context";

// Drawn by the tile worker so overzoom resamples across tile edges and composites once.

const PANE_NAME = "shade-field";
const PANE_Z_INDEX = 275; // under commercial (280), over canopy

const MIN_ZOOM = 10;
const MAX_ZOOM = 20;
// Keep in sync with SHADE_MAX_ZOOM in scripts/shade-schedule.ts.
const MAX_NATIVE_ZOOM = 14;
// One past the deepest baked level: deeper wastes costly levels, shallower pulls 4x the chunks.
const VECTOR_ZOOM = MAX_NATIVE_ZOOM + 1;

// Bins are sun positions only at their synthesis latitude, so schedule and pyramid are per city.
const scheduleUrl = (cityId: string): string =>
  `tiles/shade/${cityId}/buckets.json`;
const tileUrl = (cityId: string): string =>
  `tiles/shade/${cityId}/{bin}/{z}/{x}/{y}.webp`;
const treeTileUrl = (cityId: string): string =>
  `tiles/tree-shade/${cityId}/{bin}/{z}/{x}/{y}.webp`;
const TILE_SIZE = 256;
const FADE_MS = 300;
const HORIZON_DEG = 0.5; // degrees; at or below, the sun is down

// suncalc@2.0.1 returns altitude/azimuth in degrees; azimuth is clockwise from north.
const sun = SunCalc as unknown as {
  getPosition: (
    date: Date,
    lat: number,
    lng: number,
  ) => { altitude: number; azimuth: number };
};

// (declination, hourAngle) is what the client selects on; the sun position is in degrees.
interface Bin {
  index: number;
  season: number;
  hourAngle: number;
  elevation: number;
  azimuth: number;
}

const schedules = new Map<string, Promise<Bin[]>>();
// Its own token, so the schedule's verdict stays apart from the per-bin tile layers'.
const SCHEDULE_TOKEN = Symbol("shade schedule");

function loadSchedule(cityId: string): Promise<Bin[]> {
  const cached = schedules.get(cityId);
  if (cached) {
    return cached;
  }
  const promise: Promise<Bin[]> = fetch(scheduleUrl(cityId))
    .then((response) => {
      reportLayerData("shade", SCHEDULE_TOKEN, true);
      return response.ok ? response.json() : [];
    })
    // An empty schedule mounts nothing, so no tile ever errors; report it here instead.
    .catch(() => {
      reportLayerData("shade", SCHEDULE_TOKEN, false);
      schedules.delete(cityId);
      return [] as Bin[];
    });
  schedules.set(cityId, promise);
  return promise;
}

function currentSun(): { elevation: number; azimuth: number } {
  const position = sun.getPosition(
    getResolvedDate(),
    activeCity().center.lat,
    activeCity().center.lng,
  );
  return {
    elevation: position.altitude,
    azimuth: ((position.azimuth % 360) + 360) % 360,
  };
}

// Defined below the horizon too, so the prefetch can order the day's bins around a night-time pick.
function currentHourAngle(): number {
  const { elevation, azimuth } = currentSun();
  const declination = declinationOf(
    elevation,
    azimuth,
    activeCity().center.lat,
  );
  return hourAngleOf(elevation, azimuth, activeCity().center.lat, declination);
}

// Season band first, then the nearest hour-angle step, so scrubbing walks the bins in order.
function pickBin(bins: Bin[], elevation: number, azimuth: number): Bin | null {
  const declination = declinationOf(
    elevation,
    azimuth,
    activeCity().center.lat,
  );
  const hourAngle = hourAngleOf(
    elevation,
    azimuth,
    activeCity().center.lat,
    declination,
  );
  const season = seasonBand(declination);
  let best: Bin | null = null;
  let bestKey = Number.POSITIVE_INFINITY;
  for (const bin of bins) {
    // The band penalty dwarfs any hour-angle span, so the matching band wins outright.
    const penalty = bin.season === season ? 0 : 1e6;
    const key = penalty + Math.abs(bin.hourAngle - hourAngle);
    if (key < bestKey) {
      bestKey = key;
      best = bin;
    }
  }
  return best;
}

export default function ShadeLayer() {
  const map = useMap();
  const city = useCity();

  useEffect(() => {
    // A pane of its own, so the wash sits above the canopy fill and below the commercial band.
    if (!map.getPane(PANE_NAME)) {
      const pane = map.createPane(PANE_NAME);
      pane.style.zIndex = String(PANE_Z_INDEX);
    }

    let canceled = false;
    let bins: Bin[] = [];
    let activeIndex = -1;
    // Held until the bin changes, or scrubbed tiles won't line up with their neighbors.
    let sweepSun = currentSun();
    let drawnTau = canopyTau(getResolvedDate());
    // Only the visible bin, plus the outgoing one until its fade ends.
    const layers = new Map<number, WorkerTileLayer>();
    const ready = new Set<number>();
    // One bin is visible at a time (two mid-fade), so the layers menu badges the one on screen.
    const watching = new Map<number, () => void>();

    // A CSS opacity transition turns setOpacity into a crossfade; `load` marks the bin ready.
    const layerFor = ({ index, elevation, azimuth }: Bin): WorkerTileLayer => {
      const existing = layers.get(index);
      if (existing) {
        return existing;
      }
      // Captured, since a bin rescrubbed within the fade could paint from a sun 72 minutes off.
      const castFrom = sweepSun;
      const layer = new WorkerTileLayer(
        () => ({
          kind: "shade",
          // Captured, since a switch flips the global city before cleanup detaches this layer.
          url: tileUrl(city.id),
          treeUrl: treeTileUrl(city.id),
          bin: index,
          maxNativeZoom: MAX_NATIVE_ZOOM,
          tau: canopyTau(getResolvedDate()),
          intensity: Math.max(0, Math.sin((elevation * Math.PI) / 180)),
          vectorZoom: VECTOR_ZOOM,
          binElevation: elevation,
          binAzimuth: azimuth,
          sunElevation: castFrom.elevation,
          sunAzimuth: castFrom.azimuth,
        }),
        {
          pane: PANE_NAME,
          minZoom: MIN_ZOOM,
          maxZoom: MAX_ZOOM,
          // No maxNativeZoom, or Leaflet stretches tiles instead of the worker magnifying them.
          opacity: 0,
          keepBuffer: KEEP_BUFFER,
        },
      );
      layer.on("load", () => ready.add(index));
      // Before it goes on the map, or the first load cycle's `loading` is missed.
      watching.set(index, watchLayerStatus(layer, "shade"));
      layer.addTo(map);
      const container = layer.getContainer();
      if (container) {
        container.style.transition = `opacity ${FADE_MS}ms ease`;
      }
      layers.set(index, layer);
      return layer;
    };

    const evict = (index: number): void => {
      const layer = layers.get(index);
      if (layer) {
        watching.get(index)?.();
        watching.delete(index);
        layer.remove();
        layers.delete(index);
        ready.delete(index);
      }
    };

    // Fade a bin out, then drop it, unless it became active again mid-fade.
    const retire = (index: number): void => {
      const layer = layers.get(index);
      if (index < 0 || !layer) {
        return;
      }
      layer.setOpacity(0);
      window.setTimeout(() => {
        if (!canceled && activeIndex !== index) {
          evict(index);
        }
      }, FADE_MS);
    };

    // One date has one declination, so read at noon, where the band is unambiguous.
    const pickedBand = (): number => {
      const noon = getResolvedDate();
      noon.setHours(12, 0, 0, 0);
      const position = sun.getPosition(
        noon,
        activeCity().center.lat,
        activeCity().center.lng,
      );
      const azimuth = ((position.azimuth % 360) + 360) % 360;
      return seasonBand(
        declinationOf(position.altitude, azimuth, activeCity().center.lat),
      );
    };

    // Plus, where magnified, the ring of neighbors a draw samples for its margin.
    const viewSources = (): TileCoords[] => {
      const view = Math.round(map.getZoom());
      const zoom = Math.min(view, MAX_NATIVE_ZOOM);
      const ring = view > MAX_NATIVE_ZOOM ? 1 : 0;
      const bounds = map.getBounds();
      const topLeft = map
        .project(bounds.getNorthWest(), zoom)
        .divideBy(TILE_SIZE)
        .floor();
      const bottomRight = map
        .project(bounds.getSouthEast(), zoom)
        .divideBy(TILE_SIZE)
        .floor();
      const last = 2 ** zoom - 1;
      const coords: TileCoords[] = [];
      for (
        let y = Math.max(0, topLeft.y - ring);
        y <= Math.min(last, bottomRight.y + ring);
        y++
      ) {
        for (
          let x = Math.max(0, topLeft.x - ring);
          x <= Math.min(last, bottomRight.x + ring);
          x++
        ) {
          coords.push({ x, y, z: zoom });
        }
      }
      return coords;
    };

    // While the popover is open, the worker decodes the picked date's band nearest-first.
    const syncPrefetch = (): void => {
      // Past the handoff the sweep uses sun-independent caster chunks already cached.
      if (
        isPickerOpen() &&
        bins.length > 0 &&
        Math.round(map.getZoom()) < VECTOR_ZOOM
      ) {
        const band = pickedBand();
        const hourAngle = currentHourAngle();
        const ordered = bins
          .filter((bin) => bin.season === band)
          .sort(
            (left, right) =>
              Math.abs(left.hourAngle - hourAngle) -
              Math.abs(right.hourAngle - hourAngle),
          );
        prefetchShadeTiles({
          type: "shade-prefetch",
          url: tileUrl(city.id),
          treeUrl: treeTileUrl(city.id),
          bins: ordered.map(({ index }) => index),
          coords: viewSources(),
        });
      }
    };

    // Deck geometry hangs off the routing graph here; past the handoff, a deck exceeds a pixel.
    let deckDay = Number.NaN;
    const syncSheds = (): void => {
      const day = shedDay(getResolvedDate());
      if (Math.round(map.getZoom()) < VECTOR_ZOOM || day === deckDay) {
        return;
      }
      deckDay = day;
      Promise.all([loadGraph(city.id), loadSheds()]).then(
        ([graph, history]) => {
          if (!canceled && deckDay === day) {
            sendShedDecks(shedDecks(graph, history, day));
            for (const layer of layers.values()) {
              layer.redraw();
            }
          }
        },
        () => {},
      );
    };

    // The previous layer stays visible until the target has painted, so nothing flashes blank.
    const apply = (): void => {
      syncPrefetch();
      syncSheds();
      if (bins.length === 0) {
        return;
      }
      const { elevation, azimuth } = currentSun();
      const bin =
        elevation > HORIZON_DEG ? pickBin(bins, elevation, azimuth) : null;
      const target = bin ? bin.index : -1;
      const tau = canopyTau(getResolvedDate());
      if (target === activeIndex) {
        // Tau is baked into the pixels, and a date can cross half of leaf-fall within one bin.
        if (tau !== drawnTau) {
          drawnTau = tau;
          layers.get(target)?.redraw();
        }
        return;
      }
      activeIndex = target;
      drawnTau = tau;
      sweepSun = { elevation, azimuth };
      // A bin scrubbed through faster than it loads would strand, as its crossfade waits on `load`.
      const retireOthers = (): void => {
        for (const index of [...layers.keys()]) {
          if (index !== activeIndex) {
            retire(index);
          }
        }
      };
      if (!bin) {
        retireOthers();
        return;
      }
      const layer = layerFor(bin);
      const crossfade = (): void => {
        if (canceled || activeIndex !== target) {
          return;
        }
        layer.setOpacity(1);
        retireOthers();
      };
      if (ready.has(target)) {
        crossfade();
      } else {
        layer.once("load", crossfade);
      }
    };

    loadSchedule(city.id).then((loaded) => {
      if (!canceled) {
        bins = loaded;
        apply();
      }
    });
    const unsubscribe = subscribeRouteTime(apply);
    // A zoom past the handoff is what first asks for the sheds.
    const moved = (): void => {
      syncPrefetch();
      syncSheds();
    };
    map.on("moveend", moved);

    return () => {
      canceled = true;
      unsubscribe();
      map.off("moveend", moved);
      for (const detach of watching.values()) {
        detach();
      }
      for (const layer of layers.values()) {
        layer.remove();
      }
    };
  }, [map, city.id]);

  return null;
}
