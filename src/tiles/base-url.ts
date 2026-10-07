// In a worker a relative URL resolves against the worker script, not the page.

let documentBase = "";

export function setBaseUrl(base: string): void {
  documentBase = base;
}

export function resolveUrl(path: string): string {
  return new URL(path, documentBase).href;
}
