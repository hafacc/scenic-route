// A worker resolves relative fetches against its chunk directory, so the page hands it the deploy base.

let base: string | null = null;

export function setArtifactBase(href: string): void {
  base = href;
}

export function artifactUrl(path: string): string {
  return base === null ? path : new URL(path, base).href;
}
