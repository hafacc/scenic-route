// Checks sheds against the current key-space inputs; unlike `check-sheds`, needs no built graph.

import { SHED_CITIES, type ShedCity } from "../src/routing/shed-cities";
import {
  currentShedInputs,
  readShedInputs,
  type ShedInputs,
} from "./graph-inputs";

const BLANKS =
  " every shed resolves to nothing on the map — silently, since the client blanks rather than" +
  " misplaces.";

export function shedInputsMismatch(
  city: ShedCity,
  recorded: ShedInputs | null,
  current: ShedInputs,
): string | null {
  const record = `public/sheds/${city}/inputs.json`;
  const fix =
    " A graph-input change and its re-place are one change: `bun run build-sheds`, then commit" +
    ` public/sheds/${city}. scripts/README.md has the whole refresh procedure.`;
  if (recorded === null) {
    return (
      `${record} is missing, so nothing says which inputs the committed ${city} shed artifact was` +
      " placed against, and a deploy would be the first thing to find out whether it resolves onto" +
      ` the graph it ships.${fix}`
    );
  } else if (recorded.stamp !== current.stamp) {
    return (
      `the ${city} shed artifact was placed against key-space inputs stamped ${recorded.stamp} and` +
      ` the committed ones stamp ${current.stamp}: a street, path or sidewalk source moved, the` +
      ` deploy builds its graph from that source, and if it cut one edge differently${BLANKS}${fix}`
    );
  } else if (recorded.keySpace !== current.keySpace) {
    return (
      `the ${city} shed artifact was placed by a tiler whose key probe landed on` +
      ` ${recorded.keySpace} and this one lands on ${current.keySpace}: the key assignment itself` +
      ` changed, so the graph the deploy builds keys its edges differently and${BLANKS}${fix}`
    );
  } else {
    return null;
  }
}

export async function checkShedInputs(): Promise<void> {
  const mismatches: string[] = [];
  for (const city of SHED_CITIES) {
    const [recorded, current] = await Promise.all([
      readShedInputs(city),
      currentShedInputs(city),
    ]);
    const mismatch = shedInputsMismatch(city, recorded, current);
    if (mismatch === null) {
      console.error(
        `sheds (${city}): placed against ${current.files} committed key-space inputs stamped` +
          ` ${current.stamp}, by a tiler whose key probe lands on ${current.keySpace}`,
      );
    } else {
      mismatches.push(mismatch);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(mismatches.join("\n"));
  }
}

if (import.meta.main) {
  await checkShedInputs();
}
