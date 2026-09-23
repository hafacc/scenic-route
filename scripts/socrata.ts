import pRetry from "p-retry";
import { cached } from "./cache";

export interface Coord {
  lat: number;
  lng: number;
}

// ForMS `dbh` is whole inches; `genus` is "" when unknown.
export interface Tree extends Coord {
  dbhInches: number;
  genus: string;
}

const PAGE_SIZE = 50_000;
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
const TREE_DATASET = "hn5i-inap"; // ForMS "Forestry Tree Points"
const TREE_COUNT = 898_618; // standing trees at the last refresh
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

async function fetchJson<Row>(url: string): Promise<Row[]> {
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
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
        onFailedAttempt: ({ error, attemptNumber }) => {
          console.error(
            `  attempt ${attemptNumber}/${MAX_ATTEMPTS} failed after ${attemptShape(Date.now() - attemptStarted)}: ${error}`,
          );
        },
      },
    );
  } catch (error) {
    // A diagnostic read without the token, from where the failure happened; not a retry.
    if (APP_TOKEN !== undefined) {
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
      const url = new URL(`https://${host}/resource/${dataset}.json`);
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value);
      }
      url.searchParams.set("$order", ":id");
      url.searchParams.set("$limit", String(PAGE_SIZE));
      url.searchParams.set("$offset", String(offset));

      const page = await fetchJson<Row>(url.toString());
      for (const row of page) {
        rows.push(row);
      }
      console.error(`  fetched ${rows.length}/${expected}`);
      if (page.length < PAGE_SIZE) {
        // A capped or throttled page would otherwise pass for the end of the dataset.
        if (rows.length < expected * (1 - SHORTFALL)) {
          throw new Error(
            `${dataset} returned ${rows.length} rows, ${expected} expected: the read was truncated`,
          );
        } else if (rows.length !== expected) {
          console.error(
            `  note: ${dataset} has ${rows.length} rows, not the ${expected} expected`,
          );
        }
        return rows;
      }
    }
  });
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

// `tpstructure='Full'` excludes stumps and empty pits; a missing dbh is 0 for the ingest to impute.
export async function fetchNycTrees(): Promise<Tree[]> {
  // `*`: the cache keys on the query, so a narrow $select would re-page on every added column.
  const rows = await NYC_OPEN_DATA.dataset<{
    geometry?: string;
    dbh?: string;
    genusspecies?: string;
  }>(TREE_DATASET, { $select: "*", $where: "tpstructure='Full'" }, TREE_COUNT);
  const trees: Tree[] = [];
  for (const row of rows) {
    const coord = row.geometry ? parseWktPoint(row.geometry) : null;
    if (coord) {
      const dbh = Number.parseInt(row.dbh ?? "", 10);
      trees.push({
        ...coord,
        dbhInches: Number.isFinite(dbh) ? dbh : 0,
        genus: genusOf(row.genusspecies),
      });
    }
  }
  return trees;
}
