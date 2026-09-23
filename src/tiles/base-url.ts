// In a worker a relative URL resolves against the worker script, losing the deploy's basePath.

let documentBase = "";

export function setBaseUrl(base: string): void {
  documentBase = base;
}

export function resolveUrl(path: string): string {
  return new URL(path, documentBase).href;
}
