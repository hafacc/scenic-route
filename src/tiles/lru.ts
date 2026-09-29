// A promise cache by key that evicts the least recently used past `limit`; a failure is dropped so it retries.
export function cachedLru<Value>(
  cache: Map<string, Promise<Value>>,
  key: string,
  limit: number,
  make: () => Promise<Value>,
): Promise<Value> {
  const pending = cache.get(key);
  if (pending) {
    // Re-inserted, so iteration order is recency.
    cache.delete(key);
    cache.set(key, pending);
    return pending;
  }
  const request = make().catch((error: unknown) => {
    // Only this request: an evicted one's late failure mustn't drop its replacement.
    if (cache.get(key) === request) {
      cache.delete(key);
    }
    throw error;
  });
  cache.set(key, request);
  while (cache.size > limit) {
    const [oldest] = cache.keys();
    cache.delete(oldest);
  }
  return request;
}
