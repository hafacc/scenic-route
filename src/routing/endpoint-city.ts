// A city arriving with its endpoints (a shared link, say) is adopted; only leaving the recorded one is.
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
