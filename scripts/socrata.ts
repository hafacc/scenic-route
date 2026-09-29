import pRetry from "p-retry";
import { cached, dropEntry, readEntry, writeEntry } from "./cache";
import { type TreeTable, TreeTableBuilder } from "./tree-table";

export interface Coord {
  lat: number;
  lng: number;
}

// ForMS `dbh` is whole inches; `genus` is "" when unknown.
export interface Tree extends Coord {
  dbhInches: number;
  genus: string;
}

export const PAGE_SIZE = 50_000;
// Eight attempts capped at two minutes span 20+ minutes, enough to outlast an outage.
const MAX_ATTEMPTS = 8;
const RETRY_BASE_MS = 2_000;
const RETRY_CAP_MS = 120_000;
// 4x the heaviest observed read
const REQUEST_TIMEOUT_MS = 90_000;
// `||`: an unset CI secret arrives as "", which must not be sent as a token.
const APP_TOKEN = process.env.SOCRATA_APP_TOKEN || undefined;
// Keys per `field in (...)`; past ~1,100 the URL gets a 414.
const BATCH_KEYS = 200;
const BATCH_WORKERS = 8;
const BATCH_PROGRESS = 50; // batches between progress lines
export const TREE_DATASET = "hn5i-inap"; // ForMS "Forestry Tree Points"
export const TREE_COUNT = 898_618; // standing trees at the last refresh
// A shortfall past this is a truncated read rather than removals.
const SHORTFALL = 0.05;

// Keyed on host too: two cities can publish the same 4x4 dataset id.
function cacheKey(host: string, query: Record<string, string>): string {
  return JSON.stringify({ host, ...query });
}

// Bun's per-connection socket logging, for CI.
const VERBOSE = process.env.SOCRATA_VERBOSE === "1";

function attemptShape(elapsedMs: number): string {
  const seconds = (elapsedMs / 1000).toFixed(1);
  if (elapsedMs >= REQUEST_TIMEOUT_MS - 1_000) {
    return `${seconds}s (ran out the clock)`;
  } else if (elapsedMs < 5_000) {
    return `${seconds}s (refused early)`;
  } else {
    return `${seconds}s`;
  }
}

// p-retry gives up on a TypeError it doesn't recognize, which includes Bun's socket-closed error.
async function retryable<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof TypeError) {
      const restated = new Error(error.message, { cause: error });
      restated.stack = error.stack;
      throw restated;
    }
    throw error;
  }
}

// `signal` abandons the read, retries and all, e.g. a read-ahead nobody will consume.
async function fetchJson<Row>(
  url: string,
  signal?: AbortSignal,
): Promise<Row[]> {
  const headers: Record<string, string> =
    APP_TOKEN === undefined ? {} : { "X-App-Token": APP_TOKEN };
  try {
    let attemptStarted = Date.now();
    return await pRetry(
      async () => {
        attemptStarted = Date.now();
        const response = await retryable(() =>
          fetch(url, {
            headers,
            signal:
              signal === undefined
                ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
                : AbortSignal.any([
                    signal,
                    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                  ]),
            verbose: VERBOSE,
          } as RequestInit),
        );
        if (!response.ok) {
          // Socrata explains the failure in headers; e.g. a bad token and over-quota are both 403.
          const told = ["x-socrata-requestid", "x-error-code", "server", "date"]
            .map((name) => `${name}=${response.headers.get(name) ?? "-"}`)
            .join(" ");
          throw new Error(`${response.status} ${response.statusText} ${told}`);
        }
        return (await retryable(() => response.json())) as Row[];
      },
      {
        retries: MAX_ATTEMPTS - 1,
        minTimeout: RETRY_BASE_MS,
        maxTimeout: RETRY_CAP_MS,
        randomize: true,
        signal,
        onFailedAttempt: ({ error, attemptNumber }) => {
          console.error(
            `  attempt ${attemptNumber}/${MAX_ATTEMPTS} failed after ${attemptShape(Date.now() - attemptStarted)}: ${error}`,
          );
        },
      },
    );
  } catch (error) {
    // A diagnostic read without the token, from where the failure happened; not a retry.
    if (APP_TOKEN !== undefined && !signal?.aborted) {
      const verdict = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
      }).then(
        (response) => `answered ${response.status}`,
        (reason) => `failed too: ${reason}`,
      );
      console.error(`  the same read without the app token ${verdict}`);
    }
    throw new Error(`failed to fetch ${url}: ${error}`);
  }
}

function pageQuery(
  query: Record<string, string>,
  pageSize: number,
  offset: number,
): Record<string, string> {
  return {
    ...query,
    $order: ":id",
    $limit: String(pageSize),
    $offset: String(offset),
  };
}

function resourceUrl(
  host: string,
  dataset: string,
  query: Record<string, string>,
): string {
  const url = new URL(`https://${host}/resource/${dataset}.json`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

// A capped or throttled page would otherwise pass for the end of the dataset.
function checkCount(dataset: string, rows: number, expected: number): void {
  if (rows < expected * (1 - SHORTFALL)) {
    throw new Error(
      `${dataset} returned ${rows} rows, ${expected} expected: the read was truncated`,
    );
  } else if (rows !== expected) {
    console.error(
      `  note: ${dataset} has ${rows} rows, not the ${expected} expected`,
    );
  }
}

// `:id` is the only order Socrata keeps stable across the pages of one read.
async function fetchDataset<Row>(
  host: string,
  dataset: string,
  query: Record<string, string>,
  expected: number,
): Promise<Row[]> {
  return await cached(dataset, cacheKey(host, query), async () => {
    const rows: Row[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await fetchJson<Row>(
        resourceUrl(host, dataset, pageQuery(query, PAGE_SIZE, offset)),
      );
      for (const row of page) {
        rows.push(row);
      }
      console.error(`  fetched ${rows.length}/${expected}`);
      if (page.length < PAGE_SIZE) {
        checkCount(dataset, rows.length, expected);
        return rows;
      }
    }
  });
}

// A page's cache entry and URL.
export function pageEntry(
  host: string,
  dataset: string,
  query: Record<string, string>,
  pageSize: number,
  offset: number,
): { name: string; key: string; url: string } {
  const paged = pageQuery(query, pageSize, offset);
  return {
    name: `${dataset}-${offset}`,
    key: cacheKey(host, paged),
    url: resourceUrl(host, dataset, paged),
  };
}

export interface Paging {
  pageSize?: number;
  // Pages fetched and parsed at once; one keeps a single page in memory.
  concurrency?: number;
}

// The offset of a finished read's short last page.
interface PagesMarker {
  lastOffset: number;
}

// Named like page 0 with the same digest, so a finished read's pages and marker sit side by side.
export function completeEntry(
  host: string,
  dataset: string,
  query: Record<string, string>,
  pageSize: number,
): { name: string; key: string } {
  const first = pageEntry(host, dataset, query, pageSize, 0);
  return { name: `${dataset}-complete`, key: first.key };
}

// A page an entry, trusted only under a marker the count check writes, so no partial read is stitched.
async function* fetchPages<Row>(
  host: string,
  dataset: string,
  query: Record<string, string>,
  expected: number,
  { pageSize = PAGE_SIZE, concurrency = 1 }: Paging = {},
): AsyncGenerator<Row[]> {
  const marker = completeEntry(host, dataset, query, pageSize);
  // Offline, a missing marker has already thrown here.
  const vouched = await readEntry<PagesMarker>(marker.name, marker.key);
  if (vouched === null) {
    // A stale marker would otherwise vouch for pages this read is about to replace.
    await dropEntry(marker.name, marker.key);
  }
  // A vouched read stops at the offset its marker names, so no read-ahead asks for a page past it.
  const lastOffset = vouched?.value.lastOffset ?? Number.POSITIVE_INFINITY;
  const controller = new AbortController();
  // Only a full page is cached as it arrives; the short last one waits for the count check.
  const read = async (offset: number): Promise<Row[]> => {
    const entry = pageEntry(host, dataset, query, pageSize, offset);
    if (vouched !== null) {
      const hit = await readEntry<Row[]>(entry.name, entry.key);
      if (hit === null) {
        // A live page can't be stitched to cached ones, so the next run refetches the whole read.
        await dropEntry(marker.name, marker.key);
        throw new Error(
          `${dataset}: the cache lost page ${offset} of a finished read; rerun to fetch it afresh`,
        );
      }
      return hit.value;
    }
    const page = await fetchJson<Row>(entry.url, controller.signal);
    if (page.length === pageSize) {
      await writeEntry(entry.name, entry.key, page);
    }
    return page;
  };
  // Reads run ahead in offset order; one past the end just comes back empty.
  const ahead: { offset: number; page: Promise<Row[]> }[] = [];
  let next = 0;
  let rows = 0;
  try {
    for (;;) {
      while (ahead.length < Math.max(1, concurrency) && next <= lastOffset) {
        const page = read(next);
        page.catch(() => {}); // surfaced when awaited, not as an unhandled rejection
        ahead.push({ offset: next, page });
        next += pageSize;
      }
      const { offset, page: pending } = ahead.shift() as (typeof ahead)[0];
      const page = await pending;
      rows += page.length;
      console.error(`  ${dataset}: fetched ${rows}/${expected}`);
      yield page;
      if (page.length < pageSize) {
        const last = pageEntry(host, dataset, query, pageSize, offset);
        try {
          checkCount(dataset, rows, expected);
        } catch (error) {
          await dropEntry(last.name, last.key);
          await dropEntry(marker.name, marker.key);
          throw error;
        }
        if (vouched === null) {
          await writeEntry(last.name, last.key, page);
          await writeEntry(marker.name, marker.key, {
            lastOffset: offset,
          } satisfies PagesMarker);
        }
        return;
      }
    }
  } finally {
    controller.abort();
    await Promise.allSettled(ahead.map(({ page }) => page));
  }
}

// Named, not positional: both are counts, so a swap would still typecheck.
export interface Batching {
  batchKeys?: number;
  concurrency?: number;
}

// Each batch is cached separately, so a failed batch doesn't cost the whole read.
async function fetchKeyed<Row>(
  host: string,
  dataset: string,
  select: string,
  field: string,
  keys: Iterable<string>,
  { batchKeys = BATCH_KEYS, concurrency = BATCH_WORKERS }: Batching = {},
): Promise<Row[]> {
  const sorted = [...new Set(keys)].sort();
  const batches: string[][] = [];
  for (let start = 0; start < sorted.length; start += batchKeys) {
    batches.push(sorted.slice(start, start + batchKeys));
  }

  const pages: Row[][] = new Array(batches.length);
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    while (next < batches.length) {
      const index = next++;
      const batch = batches[index];
      pages[index] = await cached(
        `${dataset}.${field}`,
        cacheKey(host, { $select: select, batch: batch.join(",") }),
        async () => {
          const url = new URL(`https://${host}/resource/${dataset}.json`);
          const list = batch.map((key) => `'${key}'`).join(",");
          url.searchParams.set("$select", select);
          url.searchParams.set("$where", `${field} in (${list})`);
          url.searchParams.set("$limit", String(PAGE_SIZE));
          return await fetchJson<Row>(url.toString());
        },
        { quiet: true },
      );
      done += 1;
      if (done % BATCH_PROGRESS === 0 || done === batches.length) {
        console.error(`  ${dataset}: ${done}/${batches.length} batches`);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, batches.length) }, worker),
  );
  return pages.flat();
}

export interface Socrata {
  dataset<Row>(
    dataset: string,
    query: Record<string, string>,
    expected: number,
  ): Promise<Row[]>;
  // The same read a page at a time; the cache holds pages, not the dataset.
  pages<Row>(
    dataset: string,
    query: Record<string, string>,
    expected: number,
    paging?: Paging,
  ): AsyncGenerator<Row[]>;
  keyed<Row>(
    dataset: string,
    select: string,
    field: string,
    keys: Iterable<string>,
    batching?: Batching,
  ): Promise<Row[]>;
  // Human-readable dataset page.
  page(dataset: string): string;
}

function socrata(host: string): Socrata {
  return {
    dataset: (dataset, query, expected) =>
      fetchDataset(host, dataset, query, expected),
    pages: (dataset, query, expected, paging) =>
      fetchPages(host, dataset, query, expected, paging),
    keyed: (dataset, select, field, keys, batching) =>
      fetchKeyed(host, dataset, select, field, keys, batching),
    page: (dataset) => `https://${host}/d/${dataset}`,
  };
}

export const NYC_OPEN_DATA = socrata("data.cityofnewyork.us");
export const DATA_SF = socrata("data.sf.gov");
// New York State's portal: the MTA is a state authority and publishes its station data here.
export const NY_STATE_OPEN_DATA = socrata("data.ny.gov");

// Socrata returns points as WKT, e.g. "POINT(-73.8165 40.7162)" (lng first).
export function parseWktPoint(wkt: string): Coord | null {
  const match =
    /^POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)$/.exec(
      wkt.trim(),
    );
  if (!match) {
    return null;
  } else {
    return { lng: Number(match[1]), lat: Number(match[2]) };
  }
}

// "Acer nigrum - black maple" -> "Acer"; blank or "Unknown" -> "".
function genusOf(genusspecies: string | undefined): string {
  const scientific = (genusspecies ?? "").split(" - ")[0].trim();
  const genus = scientific.split(/\s+/)[0] ?? "";
  if (genus === "" || genus === "Unknown") {
    return "";
  } else {
    return genus;
  }
}

export interface TreeRow {
  geometry?: string;
  dbh?: string;
  genusspecies?: string;
}

// Rows without a parseable point are skipped.
export function treesOfRows(
  rows: readonly TreeRow[],
  into: TreeTableBuilder,
): void {
  for (const row of rows) {
    const coord = row.geometry ? parseWktPoint(row.geometry) : null;
    if (coord) {
      const dbh = Number.parseInt(row.dbh ?? "", 10);
      into.push(
        coord.lat,
        coord.lng,
        Number.isFinite(dbh) ? dbh : 0,
        genusOf(row.genusspecies),
      );
    }
  }
}

// `tpstructure='Full'` excludes stumps and empty pits; a missing dbh is 0 for the ingest to impute.
export const NYC_TREE_QUERY = {
  $select: "geometry,dbh,genusspecies",
  $where: "tpstructure='Full'",
};

// Paged, so only one page's rows are alive beside the trees; `paging` sets how many at once.
export async function fetchNycTrees(paging: Paging = {}): Promise<TreeTable> {
  const trees = new TreeTableBuilder();
  for await (const rows of NYC_OPEN_DATA.pages<TreeRow>(
    TREE_DATASET,
    NYC_TREE_QUERY,
    TREE_COUNT,
    paging,
  )) {
    treesOfRows(rows, trees);
  }
  return trees.finish();
}
