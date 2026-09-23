// Prints the blob ids the shed walk needs, one a line, for `git cat-file --batch` to stream back.
// The consumer at the far end of the pipe must get the same `--from` day to map blobs to commits.

import { distinctBlobs, loadSnapshotIndex } from "./shed-permits";

const [index, flag, from] = process.argv.slice(2);
if (
  index === undefined ||
  (flag !== undefined && (flag !== "--from" || from === undefined))
) {
  throw new Error(
    "usage: bun run scripts/shed-blobs.ts <commit index> [--from <day>]",
  );
}
const sources = await loadSnapshotIndex(index, from);
// No blank line for an empty request: git dies on a query that is not an object name.
process.stdout.write(
  distinctBlobs(sources)
    .map((blob) => `${blob}\n`)
    .join(""),
);
