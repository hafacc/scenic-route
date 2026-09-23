// DOB writes names in full with padded numbers ("WEST   057 STREET"); CSCL abbreviates ("W 57 ST").

const SUFFIXES: Readonly<Record<string, string>> = {
  STREET: "ST",
  STR: "ST",
  AVENUE: "AVE",
  AVEN: "AVE",
  AV: "AVE",
  BOULEVARD: "BLVD",
  BOULEVARDE: "BLVD",
  PLACE: "PL",
  ROAD: "RD",
  DRIVE: "DR",
  PARKWAY: "PKWY",
  PARKWY: "PKWY",
  LANE: "LN",
  COURT: "CT",
  TERRACE: "TER",
  EXPRESSWAY: "EXPY",
  CIRCLE: "CIR",
  PLAZA: "PLZ",
  SQUARE: "SQ",
  TURNPIKE: "TPKE",
  HIGHWAY: "HWY",
  CRESCENT: "CRES",
  EXTENSION: "EXT",
  CONCOURSE: "CONC",
  ESPLANADE: "ESPL",
  PROMENADE: "PROM",
};

const PREFIXES: Readonly<Record<string, string>> = {
  EAST: "E",
  WEST: "W",
  NORTH: "N",
  SOUTH: "S",
  BEACH: "BCH",
  SAINT: "ST",
  MOUNT: "MT",
  FORT: "FT",
};

const SPELLED_ORDINALS: Readonly<Record<string, string>> = {
  FIRST: "1",
  SECOND: "2",
  THIRD: "3",
  FOURTH: "4",
  FIFTH: "5",
  SIXTH: "6",
  SEVENTH: "7",
  EIGHTH: "8",
  NINTH: "9",
  TENTH: "10",
  ELEVENTH: "11",
  TWELFTH: "12",
};

const GENERIC: ReadonlySet<string> = new Set([
  "ST",
  "AVE",
  "BLVD",
  "PL",
  "RD",
  "DR",
  "PKWY",
  "LN",
  "CT",
  "TER",
  "EXPY",
  "CIR",
  "PLZ",
  "SQ",
  "TPKE",
  "HWY",
  "WALK",
  "LOOP",
  "PATH",
  "ROW",
  "WAY",
  "ALY",
  "BRG",
  "TUNL",
  "SLIP",
]);

// Written joined or split depending on the feed ("MC DOUGAL ST" vs "MACDOUGAL ST").
const JOINING_PARTICLES: ReadonlySet<string> = new Set(["MC", "MAC", "DE"]);

// Scored against, not rewritten: `6 AVE` is Avenue of the Americas only in Manhattan.
const ALIASES: Readonly<Record<string, readonly string[]>> = {
  "6 AVE": ["AVE OF THE AMERICAS"],
  "AVE OF THE AMERICAS": ["6 AVE"],
  "7 AVE": ["ADAM C POWELL BLVD"],
  "ADAM C POWELL BLVD": ["7 AVE"],
  "8 AVE": ["FREDERICK DOUGLASS BLVD"],
  "FREDERICK DOUGLASS BLVD": ["8 AVE"],
  "LENOX AVE": ["MALCOLM X BLVD"],
  "MALCOLM X BLVD": ["LENOX AVE"],
  "W 110 ST": ["CATHEDRAL PKWY"],
  "CATHEDRAL PKWY": ["W 110 ST"],
};

const ORDINAL = /^(\d+)(ST|ND|RD|TH)$/;
const PUNCTUATION = /[.,'`]/g;

// Memoized: placement scores every candidate sidewalk per shed, millions of calls in all.
const normalized = new Map<string, string>();
const cores = new Map<string, ReadonlySet<string>>();
const scores = new Map<string, number>();

export function normalizeStreet(name: string): string {
  const hit = normalized.get(name);
  if (hit !== undefined) {
    return hit;
  }
  const cleaned = name
    .toUpperCase()
    .replace(PUNCTUATION, "")
    .replace(/[-/]/g, " ");
  const tokens: string[] = [];
  for (let token of cleaned.split(/\s+/)) {
    if (token === "") {
      continue;
    }
    const ordinal = ORDINAL.exec(token);
    if (ordinal) {
      token = ordinal[1];
    }
    if (/^\d+$/.test(token)) {
      token = String(Number.parseInt(token, 10)); // drop DOB's zero padding
    }
    token =
      SPELLED_ORDINALS[token] ?? PREFIXES[token] ?? SUFFIXES[token] ?? token;
    const previous = tokens[tokens.length - 1];
    if (
      previous !== undefined &&
      JOINING_PARTICLES.has(previous) &&
      /^[A-Z]/.test(token)
    ) {
      tokens[tokens.length - 1] = previous + token;
    } else {
      tokens.push(token);
    }
  }
  const value = tokens.join(" ");
  normalized.set(name, value);
  return value;
}

function coreTokens(canonical: string): ReadonlySet<string> {
  const hit = cores.get(canonical);
  if (hit !== undefined) {
    return hit;
  }
  const value = new Set(
    canonical.split(" ").filter((token) => token !== "" && !GENERIC.has(token)),
  );
  cores.set(canonical, value);
  return value;
}

function suffixOf(canonical: string): string | null {
  const tokens = canonical.split(" ");
  const last = tokens[tokens.length - 1];
  return last !== undefined && GENERIC.has(last) ? last : null;
}

function scoreCanonical(shed: string, graph: string): number {
  if (shed === graph) {
    return 1;
  }
  const shedCore = coreTokens(shed);
  const graphCore = coreTokens(graph);
  if (shedCore.size === 0 || graphCore.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const token of shedCore) {
    if (graphCore.has(token)) {
      shared += 1;
    }
  }
  // "182 ST" and the "182 PL" one block over share every distinctive token; the type must agree.
  const sameSuffix = suffixOf(shed) === suffixOf(graph);
  if (shared === shedCore.size && shared === graphCore.size) {
    return sameSuffix ? 0.75 : 0.3;
  } else {
    const overlap = shared / (shedCore.size + graphCore.size - shared);
    return (sameSuffix ? 0.7 : 0.3) * overlap;
  }
}

export function streetScore(
  shedName: string,
  graphName: string | null,
): number {
  if (graphName === null) {
    return 0;
  }
  // NUL: any separator a street name can contain would let two pairs collide.
  const key = `${shedName}\u0000${graphName}`;
  const hit = scores.get(key);
  if (hit !== undefined) {
    return hit;
  }
  const shed = normalizeStreet(shedName);
  const graph = normalizeStreet(graphName);
  let best = scoreCanonical(shed, graph);
  for (const alias of ALIASES[shed] ?? []) {
    best = Math.max(best, scoreCanonical(alias, graph));
  }
  for (const alias of ALIASES[graph] ?? []) {
    best = Math.max(best, scoreCanonical(shed, alias));
  }
  scores.set(key, best);
  return best;
}
