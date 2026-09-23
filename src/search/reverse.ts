// Names a point from ADDR and SRCH in memory; with nothing near enough it answers null, never a guess.

import { COORD_SCALE, formatHouseNumber } from "./address-format";
import { type AddressIndex, streetAddresses } from "./addresses";
import {
  type DocKind,
  tokenize,
  unpackKind,
  unpackTokenInfo,
} from "./search-format";
import { docLabel, docName, type SearchIndex } from "./search-query";

const METERS_PER_DEGREE_LAT = 111_320;
const METERS_PER_UNIT_LAT = METERS_PER_DEGREE_LAT / COORD_SCALE;

// A pin on a building is within a few tens of meters of its own number.
const AT_ADDRESS_METERS = 60;

// How far the street still names the point once the number is given up on.
const NEAR_STREET_METERS = 250;

// Squared, so only the open-space tiers (parks 235, transit 240) reach far: 20 m office, 240 m park.
const NAME_RADIUS_FLOOR = 20;
const NAME_RADIUS_SPAN = 250;
const MAX_PROMINENCE = 255;

// Sources file a place as one point, so without this a landmark loses to an office inside it.
const NAME_HEAD_START = 40;

// About as far as "near" carries on foot; past it open water gets named after the far shore.
const NEAR_NAME_METERS = 300;

// Neighborhoods are filed at their middle, so this is loose and only ever offered as "near".
const NEAR_NEIGHBORHOOD_METERS = 1000;

// `at` false means the answer is something nearby, not the thing the point is on.
export interface ReverseHit {
  kind: DocKind | "address";
  name: string; // "605 E 14th St", "Katz's Delicatessen"
  // The borough alone when merely near, or the label would place the pin at a door it isn't at.
  label: string; // "Manhattan", "205 E Houston St, Manhattan", or ""
  lat: number; // where the named thing is, which is not the point that was asked about
  lng: number;
  meters: number; // and how far that is from it
  at: boolean;
}

interface NearestAddress {
  street: number;
  name: string;
  place: string;
  lat: number;
  lng: number;
  meters: number;
}

function nameRadius(prominence: number): number {
  const share = prominence / MAX_PROMINENCE;
  return NAME_RADIUS_FLOOR + NAME_RADIUS_SPAN * share * share;
}

// An office gets a meter of head start, a shop nine, a park thirty-four.
function headStart(prominence: number): number {
  const share = prominence / MAX_PROMINENCE;
  return NAME_HEAD_START * share * share;
}

function boxGapUnits(low: number, high: number, at: number): number {
  if (at < low) {
    return low - at;
  } else if (at > high) {
    return at - high;
  } else {
    return 0;
  }
}

// Streets are decoded nearest box first, stopping once a box is farther than the best address found.
function nearestAddress(
  addresses: AddressIndex,
  lat: number,
  lng: number,
  withinMeters: number,
): NearestAddress | null {
  const metersPerDegreeLng =
    METERS_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180);
  const metersPerUnitLng = metersPerDegreeLng / COORD_SCALE;
  const latUnits = lat * COORD_SCALE;
  const lngUnits = lng * COORD_SCALE;
  const streetCount = addresses.streetName.length;
  const candidates: { street: number; meters: number }[] = [];
  for (let street = 0; street < streetCount; street += 1) {
    const north =
      boxGapUnits(
        addresses.minLatUnits[street],
        addresses.maxLatUnits[street],
        latUnits,
      ) * METERS_PER_UNIT_LAT;
    const east =
      boxGapUnits(
        addresses.minLngUnits[street],
        addresses.maxLngUnits[street],
        lngUnits,
      ) * metersPerUnitLng;
    const meters = Math.sqrt(north * north + east * east);
    if (meters <= withinMeters) {
      candidates.push({ street, meters });
    }
  }
  candidates.sort((left, right) => left.meters - right.meters);

  let best: NearestAddress | null = null;
  let bestMeters = withinMeters;
  for (const candidate of candidates) {
    if (candidate.meters > bestMeters) {
      break; // and every street behind it in the order is further still
    }
    for (const address of streetAddresses(addresses, candidate.street)) {
      const north = (address.lat - lat) * METERS_PER_DEGREE_LAT;
      const east = (address.lng - lng) * metersPerDegreeLng;
      const meters = Math.sqrt(north * north + east * east);
      if (meters < bestMeters) {
        bestMeters = meters;
        best = {
          street: candidate.street,
          name: `${formatHouseNumber(address.number)} ${addresses.names[addresses.streetName[candidate.street]]}`,
          place:
            addresses.places[addresses.streetPlace[candidate.street]] ?? "",
          lat: address.lat,
          lng: address.lng,
          meters,
        };
      }
    }
  }
  return best;
}

interface NearestNames {
  // The nearest document whose radius covers the point, after head starts.
  owner: { doc: number; meters: number; rank: number } | null;
  // The two answers left when nothing owns the point.
  nearest: { doc: number; meters: number } | null;
  neighborhood: { doc: number; meters: number } | null;
}

// Streets and neighborhoods are filed at the mean of their ground, so that distance means little.
function nearestNames(
  index: SearchIndex,
  lat: number,
  lng: number,
): NearestNames {
  const metersPerUnitLng =
    METERS_PER_UNIT_LAT * Math.cos((lat * Math.PI) / 180);
  const latUnits = lat * COORD_SCALE;
  const lngUnits = lng * COORD_SCALE;
  const found: NearestNames = {
    owner: null,
    nearest: null,
    neighborhood: null,
  };
  // A name with no words is in no posting list, so unsearchable; older files still have some.
  const findable = (doc: number): boolean =>
    tokenize(docName(index, doc)).length > 0;
  for (let doc = 0; doc < index.docCount; doc += 1) {
    const kind = unpackKind(index.kindFlags[doc]);
    if (kind === "street") {
      continue;
    }
    const north = (index.latUnits[doc] - latUnits) * METERS_PER_UNIT_LAT;
    const east = (index.lngUnits[doc] - lngUnits) * metersPerUnitLng;
    // Not Math.hypot, whose overflow guard no coordinate needs and costs 5x over 300k documents.
    const meters = Math.sqrt(north * north + east * east);
    if (kind === "neighborhood") {
      if (
        (found.neighborhood === null || meters < found.neighborhood.meters) &&
        findable(doc)
      ) {
        found.neighborhood = { doc, meters };
      }
      continue;
    }
    const rank = meters - headStart(index.prominence[doc]);
    if (
      meters <= nameRadius(index.prominence[doc]) &&
      (found.owner === null || rank < found.owner.rank) &&
      findable(doc)
    ) {
      found.owner = { doc, meters, rank };
    }
    if (
      (found.nearest === null || meters < found.nearest.meters) &&
      findable(doc)
    ) {
      found.nearest = { doc, meters };
    }
  }
  return found;
}

function documentHit(
  index: SearchIndex,
  addresses: AddressIndex,
  doc: number,
  meters: number,
  at: boolean,
): ReverseHit {
  const { placeIndex } = unpackTokenInfo(index.tokenInfo[doc]);
  return {
    kind: unpackKind(index.kindFlags[doc]),
    name: docName(index, doc),
    label: at
      ? docLabel(index, addresses, doc)
      : (addresses.places[placeIndex] ?? ""),
    lat: index.latUnits[doc] / COORD_SCALE,
    lng: index.lngUnits[doc] / COORD_SCALE,
    meters,
    at,
  };
}

// The street (without a number) or a walkable name, whichever is nearer, else the neighborhood.
function nearbyHit(
  index: SearchIndex,
  addresses: AddressIndex,
  { nearest, neighborhood }: NearestNames,
  address: NearestAddress | null,
): ReverseHit | null {
  const named =
    nearest !== null && nearest.meters <= NEAR_NAME_METERS ? nearest : null;
  if (address !== null && (named === null || address.meters <= named.meters)) {
    return {
      kind: "street",
      name: addresses.names[addresses.streetName[address.street]],
      label: addresses.places[addresses.streetPlace[address.street]] ?? "",
      lat: address.lat,
      lng: address.lng,
      meters: address.meters,
      at: false,
    };
  } else if (named !== null) {
    return documentHit(index, addresses, named.doc, named.meters, false);
  } else if (
    neighborhood !== null &&
    neighborhood.meters <= NEAR_NEIGHBORHOOD_METERS
  ) {
    return documentHit(
      index,
      addresses,
      neighborhood.doc,
      neighborhood.meters,
      false,
    );
  } else {
    return null;
  }
}

export function reverseCity(
  index: SearchIndex,
  addresses: AddressIndex,
  { lat, lng }: { lat: number; lng: number },
): ReverseHit | null {
  const address = nearestAddress(addresses, lat, lng, NEAR_STREET_METERS);
  const names = nearestNames(index, lat, lng);
  const { owner } = names;
  // A name must be nearer than the door after its head start to win.
  if (
    address !== null &&
    address.meters <= AT_ADDRESS_METERS &&
    (owner === null || address.meters <= owner.rank)
  ) {
    return {
      kind: "address",
      name: address.name,
      label: address.place,
      lat: address.lat,
      lng: address.lng,
      meters: address.meters,
      at: true,
    };
  } else if (owner !== null) {
    return documentHit(index, addresses, owner.doc, owner.meters, true);
  } else {
    return nearbyHit(index, addresses, names, address);
  }
}
