// Checks sheds against the current key-space inputs; unlike `check-sheds`, needs no built graph.

import { join } from "node:path";
import {
  currentShedInputs,
  readShedInputs,
  type ShedInputs,
} from "./graph-inputs";

const RECORD = join("public", "sheds", "inputs.json");
const FIX =
  " A graph-input change and its re-place are one change: `bun run build-sheds`, then commit" +
  ` public/sheds. scripts/README.md has the whole refresh procedure.`;
const BLANKS =
  " every shed resolves to nothing on the map — silently, since the client blanks rather than" +
  " misplaces.";

export function shedInputsMismatch(
  recorded: ShedInputs | null,
  current: ShedInputs,
): string | null {
  if (recorded === null) {
    return (
      `${RECORD} is missing, so nothing says which inputs the committed shed artifact was placed` +
      " against, and a deploy would be the first thing to find out whether it resolves onto the" +
      ` graph it ships.${FIX}`
    );
  } else if (recorded.stamp !== current.stamp) {
    return (
      `the shed artifact was placed against key-space inputs stamped ${recorded.stamp} and the` +
      ` committed ones stamp ${current.stamp}: a street, path or sidewalk source moved, the deploy` +
      ` builds its graph from that source, and if it cut one edge differently${BLANKS}${FIX}`
    );
  } else if (recorded.keySpace !== current.keySpace) {
    return (
      `the shed artifact was placed by a tiler whose key probe landed on ${recorded.keySpace} and` +
      ` this one lands on ${current.keySpace}: the key assignment itself changed, so the graph the` +
      ` deploy builds keys its edges differently and${BLANKS}${FIX}`
    );
  } else {
    return null;
  }
}

export async function checkShedInputs(): Promise<void> {
  const [recorded, current] = await Promise.all([
    readShedInputs(),
    currentShedInputs(),
  ]);
  const mismatch = shedInputsMismatch(recorded, current);
  if (mismatch !== null) {
    throw new Error(mismatch);
  }
  console.error(
    `sheds: placed against ${current.files} committed key-space inputs stamped ${current.stamp},` +
      ` by a tiler whose key probe lands on ${current.keySpace}`,
  );
}

if (import.meta.main) {
  await checkShedInputs();
}
