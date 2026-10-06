import pRetry, { AbortError, type RetryContext } from "p-retry";

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
    const { status } = response;
    const error = new Error(`${url}: ${status} ${response.statusText}`);
    // Only a 408 or a 429 among the 4xx can answer differently next time.
    const final =
      status >= 400 && status < 500 && status !== 408 && status !== 429;
    throw final ? new AbortError(error) : error;
  }
  return response;
}

// Bun's dropped connection is a TypeError p-retry takes for a bug and won't retry.
async function receive<Value>(
  url: string,
  request: HttpRequest,
  read: (response: Response) => Promise<Value>,
): Promise<Value> {
  try {
    return await read(await send(url, request));
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(`${url}: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

export async function fetchJson<Value>(
  url: string,
  request: JsonRequest<Value> = {},
): Promise<Value> {
  const { attempts = 1, check, minTimeoutMs, onFailedAttempt } = request;
  return await pRetry(
    async () => {
      const value = await receive(
        url,
        request,
        async (response) => (await response.json()) as Value,
      );
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
    () =>
      receive(
        url,
        request,
        async (response) => new Uint8Array(await response.arrayBuffer()),
      ),
    retryLadder(attempts, { minTimeoutMs, onFailedAttempt }),
  );
}
