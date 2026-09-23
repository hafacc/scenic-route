// app/icon.svg's pin, inlined so the tab icon can be swapped to a data URI without a round trip.
const PIN_PATH =
  "M16 2C9.92 2 5 6.78 5 12.67c0 7.45 9.53 16.97 9.94 17.37a1.51 1.51 0 0 0 2.12 0c.41-.4 9.94-9.92 9.94-17.37C27 6.78 22.08 2 16 2Zm0 14.58a3.92 3.92 0 1 1 0-7.84 3.92 3.92 0 0 1 0 7.84Z";

export function modeIconSvg(hex: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path fill="${hex}" fill-rule="evenodd" d="${PIN_PATH}"/></svg>`;
}

export function modeIconHref(hex: string): string {
  return `data:image/svg+xml,${encodeURIComponent(modeIconSvg(hex))}`;
}
