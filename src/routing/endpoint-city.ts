// Which city the things on the map belong to, held against the city that is actually on screen.

// Whether the city moved out from under what is on the map, and which city to remember.
//
// Adoption is not leaving: a city arrives in the same commit as the endpoints or the pin it carried
// — a shared link, a camera that reports a stale city first — and that is the thing being placed in
// the city, not carried out of it. Only a change away from the city already recorded is a leave, so
// the first city seen is adopted and remembered, and the caller drops what it holds only when the
// recorded city is left behind. Nothing on the map records nothing, so the next thing placed adopts
// wherever it lands.
export function endpointCity(
  recorded: string | null,
  cityId: string,
  hasEndpoints: boolean,
): { recorded: string | null; left: boolean } {
  if (!hasEndpoints) {
    return { recorded: null, left: false };
  } else if (recorded === null) {
    return { recorded: cityId, left: false };
  } else if (recorded === cityId) {
    return { recorded, left: false };
  } else {
    return { recorded: null, left: true };
  }
}
