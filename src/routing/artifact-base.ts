// A worker resolves a relative fetch against the chunk directory it was served from rather than the
// deploy root, so the page hands the routing worker its own base. On the page the base is never set
// and artifact paths are used exactly as written.

let base: string | null = null;

export function setArtifactBase(href: string): void {
  base = href;
}

export function artifactUrl(path: string): string {
  return base === null ? path : new URL(path, base).href;
}
