import pRetry, { type RetryContext } from "p-retry";

// Required: an Overpass mirror 429s an anonymous client on sight.
export const USER_AGENT =
  "scenic-route/0.1 (+https://github.com/erikbrinkman/scenic-route)";

const RETRY_BASE_MS = 2_000;
const RETRY_CAP_MS = 30_000;

interface LadderOptions {
  minTimeoutMs?: number;
  onFailedAttempt?: (context: RetryContext) => void;
}

// `attempts` counts in total, so 1 is no retry. Randomized so parallel workers don't retry in step.
export function retryLadder(
  attempts: number,
  { minTimeoutMs = RETRY_BASE_MS, onFailedAttempt }: LadderOptions = {},
): {
  retries: number;
  minTimeout: number;
  maxTimeout: number;
  randomize: boolean;
  onFailedAttempt?: (context: RetryContext) => void;
} {
  return {
    retries: attempts - 1,
    minTimeout: minTimeoutMs,
    maxTimeout: RETRY_CAP_MS,
    randomize: true,
    onFailedAttempt,
  };
}

export interface HttpRequest extends LadderOptions {
  // Makes the read a POST, for a batched `where` longer than a URL may be.
  body?: URLSearchParams;
  timeoutMs?: number;
  // In total, so the default of 1 gives up on the first refusal.
  attempts?: number;
}

export interface JsonRequest<Value> extends HttpRequest {
  // Runs inside the retry, since ArcGIS layers report failure in a 200.
  check?: (value: Value) => void;
}

async function send(
  url: string,
  { body, timeoutMs }: HttpRequest,
): Promise<Response> {
  const headers: Record<string, string> = { "user-agent": USER_AGENT };
  if (body) {
    headers["content-type"] = "application/x-www-form-urlencoded";
  }
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers,
    body,
    signal: timeoutMs === undefined ? null : AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`${url}: ${response.status} ${response.statusText}`);
  }
  return response;
}

export async function fetchJson<Value>(
  url: string,
  request: JsonRequest<Value> = {},
): Promise<Value> {
  const { attempts = 1, check, minTimeoutMs, onFailedAttempt } = request;
  return await pRetry(
    async () => {
      const value = (await (await send(url, request)).json()) as Value;
      check?.(value);
      return value;
    },
    retryLadder(attempts, { minTimeoutMs, onFailedAttempt }),
  );
}

export async function fetchBytes(
  url: string,
  request: Omit<HttpRequest, "body"> = {},
): Promise<Uint8Array> {
  const { attempts = 1, minTimeoutMs, onFailedAttempt } = request;
  return await pRetry(
    async () => new Uint8Array(await (await send(url, request)).arrayBuffer()),
    retryLadder(attempts, { minTimeoutMs, onFailedAttempt }),
  );
}
