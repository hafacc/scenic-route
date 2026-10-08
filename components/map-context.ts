// The Leaflet map, handed down through context.
import type L from "leaflet";
import { createContext } from "svelte";

const [mapGetter, setMapGetter] = createContext<() => L.Map | null>();

// A getter, since the map exists only after its container mounts; render the layers once it does.
export function setMap(map: () => L.Map | null): void {
  setMapGetter(map);
}

// Called while a layer component initialises, which is always after the map exists.
export function getMap(): L.Map {
  const map = mapGetter()();
  if (map === null) {
    throw new Error("getMap() ran before the map was created");
  }
  return map;
}
