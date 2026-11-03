import { hexToRgb, type ThemeName } from "../theme/palette";

// Feed route colors as the map draws them: lifted at night in OKLCH, same hue, chroma cut only to fit sRGB.

// WCAG contrast every night line reaches against the dark land; the one dial between mild and strong.
const NIGHT_CONTRAST = 3.5;

// The dark map's land as measured on screen, a shade over the basemap's earth.
const DARK_LAND = "#2d343e";

// Lines that lift onto a neighbor's night color rise further, each past the ones listed; no cycles.
const KEPT_APART: Record<string, readonly string[]> = {
  "#08179c": ["#0062cf"], // SIR, off the A C E
  "#005b95": ["#0099cc"], // Muni N, off BART Blue under Market St
  "#008547": ["#339933"], // Muni M, off BART Green
  "#bf2b45": ["#ff0000"], // Muni T, off BART Red
};
const MIN_APART = 0.12; // OKLab distance; the 1/2/3 and B/D/F/M sit about this far apart by day

const WHITE = "#ffffff";
const BLACK = "#000000";

type Vector = [number, number, number];

function toLinear(channel: number): number {
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

function toGamma(channel: number): number {
  return channel <= 0.0031308
    ? 12.92 * channel
    : 1.055 * channel ** (1 / 2.4) - 0.055;
}

function linearRgb(hex: string): Vector {
  const { red, green, blue } = hexToRgb(hex);
  return [toLinear(red / 255), toLinear(green / 255), toLinear(blue / 255)];
}

function toHex(linear: Vector): string {
  return `#${linear
    .map((channel) =>
      Math.round(Math.min(1, Math.max(0, toGamma(channel))) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function luminance(hex: string): number {
  const [red, green, blue] = linearRgb(hex);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrast(first: string, second: string): number {
  const [lighter, darker] = [luminance(first), luminance(second)].sort(
    (left, right) => right - left,
  );
  return (lighter + 0.05) / (darker + 0.05);
}

function oklab(hex: string): Vector {
  const [red, green, blue] = linearRgb(hex);
  const l = Math.cbrt(
    0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue,
  );
  const m = Math.cbrt(
    0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue,
  );
  const s = Math.cbrt(
    0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue,
  );
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function linearFromOklab([lightness, a, b]: Vector): Vector {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export function oklabDistance(first: string, second: string): number {
  const [l1, a1, b1] = oklab(first);
  const [l2, a2, b2] = oklab(second);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

function inGamut(linear: Vector): boolean {
  return linear.every((channel) => channel >= -1e-4 && channel <= 1 + 1e-4);
}

function fromLch(lightness: number, chroma: number, hue: number): string {
  const at = (scale: number) =>
    linearFromOklab([lightness, scale * Math.cos(hue), scale * Math.sin(hue)]);
  let fits = 0;
  let spills = chroma;
  if (inGamut(at(chroma))) {
    fits = chroma;
  } else {
    for (let step = 0; step < 32; step++) {
      const middle = (fits + spills) / 2;
      if (inGamut(at(middle))) {
        fits = middle;
      } else {
        spills = middle;
      }
    }
  }
  return toHex(at(fits));
}

// The darkest same-hue color at or past `target` against the land, or `color` if it is already.
function lifted(color: string, target: number): string {
  if (contrast(color, DARK_LAND) >= target) {
    return color;
  }
  const [lightness, a, b] = oklab(color);
  const chroma = Math.hypot(a, b);
  const hue = Math.atan2(b, a);
  let low = lightness;
  let high = 1;
  for (let step = 0; step < 32; step++) {
    const middle = (low + high) / 2;
    if (contrast(fromLch(middle, chroma, hue), DARK_LAND) >= target) {
      high = middle;
    } else {
      low = middle;
    }
  }
  return fromLch(high, chroma, hue);
}

// The darkest lift of `color` at least MIN_APART from each of `others`' night colors.
function liftedApart(
  color: string,
  others: readonly string[],
  target: number,
): string {
  const neighbors = others.map((other) => nightColor(other, target));
  const clear = (candidate: string) =>
    neighbors.every(
      (neighbor) => oklabDistance(candidate, neighbor) >= MIN_APART,
    );
  let low = target;
  let high = 21;
  for (let step = 0; step < 32; step++) {
    const middle = (low + high) / 2;
    if (clear(lifted(color, middle))) {
      high = middle;
    } else {
      low = middle;
    }
  }
  return lifted(color, high);
}

export function nightColor(color: string, target: number): string {
  const apart = KEPT_APART[color];
  return apart === undefined
    ? lifted(color, target)
    : liftedApart(color, apart, target);
}

const night = new Map<string, string>();

export function lineColor(color: string, theme: ThemeName): string {
  if (theme === "light") {
    return color;
  }
  let drawn = night.get(color);
  if (drawn === undefined) {
    drawn = nightColor(color, NIGHT_CONTRAST);
    night.set(color, drawn);
  }
  return drawn;
}

// A bullet's letter: the feed's by day; at night white or black, whichever stands further off the lift.
export function letterColor(
  color: string,
  textColor: string,
  theme: ThemeName,
): string {
  if (theme === "light") {
    return textColor;
  }
  const fill = lineColor(color, theme);
  return contrast(fill, WHITE) >= contrast(fill, BLACK) ? WHITE : BLACK;
}
