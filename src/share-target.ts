// Named in app/manifest.ts's `share_target`; GET, since a static export has no server.
export const SHARE_PARAMS = {
  title: "title",
  text: "text",
  url: "url",
} as const;

// Includes scheme-less `maps.app.goo.gl/AbC123`; requiring the path keeps "St. Mark's Church" out.
const LINK =
  /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/\S*/gi;
// Cutting a link leaves its neighbors' punctuation doubled; the first stands for the pair.
const DOUBLED = /([,;:·—–|-])(?:\s*[,;:·—–|-])+\s*/g;
const TRIM = /^[\s,;:·—–|-]+|[\s,;:·—–|-]+$/g;

function withoutLinks(text: string): string {
  return text
    .replace(LINK, " ")
    .replace(/\s+/g, " ")
    .replace(DOUBLED, "$1 ")
    .replace(TRIM, "");
}

// The whole string, then each comma part in written order; dashes aren't split on, or "Joe's Pizza
// — 5 min" matches 5 Minetta Street as an exact address.
export function sharedQueries(text: string): string[] {
  const whole = text.trim();
  const parts = whole
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "" && part !== whole);
  return [whole, ...parts].filter((part) => part !== "");
}

// Android has no url field, so links arrive in `text` or `title`; text leads, as addresses land there.
export function sharedDestinationText(params: URLSearchParams): string | null {
  const text = withoutLinks(params.get(SHARE_PARAMS.text) ?? "");
  const title = withoutLinks(params.get(SHARE_PARAMS.title) ?? "");
  return text || title || null;
}

// Retires the share so a reload doesn't hand the same words over again.
export function withoutShareParams(search: string): string {
  const params = new URLSearchParams(search);
  for (const key of Object.values(SHARE_PARAMS)) {
    params.delete(key);
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}
