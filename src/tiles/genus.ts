// biome-ignore-all lint/correctness/useHookAtTopLevel: gl.useProgram is WebGL, not a React hook
import type { StreetSegment } from "../streets/chunk";
import { ROAD_OPACITY } from "../theme/palette";
import { GENUS_COLORS, OTHER_GENUS_ID } from "../tree-cover/genus";
import { assemble, cutFor, type Patch, draw as resample } from "./magnify";
import type { GenusParams, TileCoords } from "./protocol";
import type { TileRenderer } from "./renderer";
import { loadStreets, STREET_LEVELS, strokeStreets } from "./street-score";
import { palette, themeName } from "./theme";

// The genus wash: hue from the genus field (crates/tiler/src/genus_field.rs), shape from the canopy.

const TILE_SIZE = 256;
const LAYERS = 4; // 3 genera per tile (RGB)
// Sampler names by texture unit: the genus layers, then the canopy and the sidewalk mask.
const SAMPLERS = [
  "data0",
  "data1",
  "data2",
  "data3",
  "canopy",
  "streets",
] as const;
const CANOPY_UNIT = SAMPLERS.indexOf("canopy");
const STREETS_UNIT = SAMPLERS.indexOf("streets");
const MIN_STREET_ZOOM = 13; // below it a sidewalk is a hairline, as in the canopy map

// Each sidewalk density level's stroke, as a red byte the shader reads back.
const MASK_COLORS: readonly string[] = Array.from(
  { length: STREET_LEVELS },
  (_unused, level) => `rgb(${level << 3}, 0, 0)`,
);

// Linear light, so the shader's blend of two hues doesn't darken between them.
const LINEAR_PALETTE = new Float32Array(
  GENUS_COLORS.flatMap(({ red, green, blue }) =>
    [red, green, blue].map((channel) => (channel / 255) ** 2.2),
  ),
);

const VERTEX = `#version 300 es
in vec2 point;
void main() { gl_Position = vec4(point, 0.0, 1.0); }`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D data0;
uniform sampler2D data1;
uniform sampler2D data2;
uniform sampler2D data3;
uniform sampler2D canopy;
uniform sampler2D streets;
uniform int size;
uniform uint mask;
uniform uint present; // the texture units this tile uploaded; the rest hold a stale tile
uniform vec3 linearPalette[12];
uniform bool dark;
uniform float valueFull; // the canopy ramp's, from src/theme/palette.ts
uniform float alphaFull;
uniform float alphaCurve;
uniform float maxAlpha;
uniform float roadOpacity;
out vec4 color;

const float GENUS_FULL = 0.1;
// Below this much named cover the hue falls to "Other", so parks and gaps read as sage.
const float THIN = 0.12;
// Pale where sparse and deep where dense, as the canopy ramp runs.
const float PALE = 0.5;
const float DEEP_LIGHT = 0.78;
const float DEEP_DARK = 1.1;
// A floor on a sidewalk's shade, so a thin line still carries its hue.
const float LINE_LIFT = 0.35;

bool enabled(int id) { return (mask & (1u << uint(id))) != 0u; }
bool has(int unit) { return (present & (1u << uint(unit))) != 0u; }

// The canopy ramp's opacity curve, so the wash has the canopy map's weight.
float rampAlpha(float value) { return maxAlpha * pow(clamp(value / alphaFull, 0.0, 1.0), alphaCurve); }

vec3 shade(vec3 hue, float level) {
  vec3 sparse = mix(hue, vec3(dark ? 0.12 : 1.0), PALE);
  vec3 dense = hue * (dark ? DEEP_DARK : DEEP_LIGHT);
  return clamp(mix(sparse, dense, level), 0.0, 1.0);
}

void main() {
  ivec2 at = ivec2(int(gl_FragCoord.x), size - 1 - int(gl_FragCoord.y));
  vec3 s0 = has(0) ? texelFetch(data0, at, 0).rgb : vec3(0.0);
  vec3 s1 = has(1) ? texelFetch(data1, at, 0).rgb : vec3(0.0);
  vec3 s2 = has(2) ? texelFetch(data2, at, 0).rgb : vec3(0.0);
  vec3 s3 = has(3) ? texelFetch(data3, at, 0).rgb : vec3(0.0);
  // Matrices, not float[12]: ANGLE fills a local array with a bare float[12](...), which Mali rejects.
  mat3x4 root = mat3x4(vec4(s0, s1.r), vec4(s1.gb, s2.rg), vec4(s2.b, s3));
  mat3x4 amount = mat3x4(0.0);
  float named = 0.0;
  for (int id = 0; id < 12; id++) {
    amount[id / 4][id % 4] = root[id / 4][id % 4] * root[id / 4][id % 4] / GENUS_FULL; // baked square-rooted
    named += amount[id / 4][id % 4];
  }
  amount[${OTHER_GENUS_ID >> 2}][${OTHER_GENUS_ID & 3}] += max(THIN - named, 0.0);

  float present = 0.0;
  float shown = 0.0;
  float weight = 0.0;
  vec3 mixed = vec3(0.0);
  for (int id = 0; id < 12; id++) {
    present += amount[id / 4][id % 4];
    if (!enabled(id)) { continue; }
    shown += amount[id / 4][id % 4];
    // The fourth power, so an area takes its leading genus's clean hue and blends only at a border.
    float squared = amount[id / 4][id % 4] * amount[id / 4][id % 4];
    float share = squared * squared;
    mixed += linearPalette[id] * share;
    weight += share;
  }
  if (weight <= 0.0) {
    color = vec4(0.0);
    return;
  }
  // A toggled-off genus takes its share of the cover with it.
  float kept = shown / present;
  vec3 hue = pow(mixed / weight, vec3(1.0 / 2.2));

  float canopyAlpha = rampAlpha(texelFetch(canopy, at, 0).a);
  float level = canopyAlpha / maxAlpha;
  float alpha = canopyAlpha * kept;
  vec4 wash = vec4(shade(hue, level) * alpha, alpha); // premultiplied, matching the canvas

  vec4 street = has(${STREETS_UNIT}) ? texelFetch(streets, at, 0) : vec4(0.0);
  if (street.a > 0.0) {
    float cover = street.r + 4.0 / 255.0; // the level's midpoint, as the canopy map strokes it
    float lineAlpha = min(1.0, rampAlpha(cover) * roadOpacity) * street.a * kept;
    float lineLevel = clamp(cover / valueFull, 0.0, 1.0);
    vec3 line = shade(hue, LINE_LIFT + (1.0 - LINE_LIFT) * lineLevel);
    wash = vec4(line * lineAlpha, lineAlpha) + wash * (1.0 - lineAlpha);
  }
  color = wash;
}`;

const UNIFORMS = [
  ...SAMPLERS,
  "size",
  "mask",
  "present",
  "linearPalette",
  "dark",
  "valueFull",
  "alphaFull",
  "alphaCurve",
  "maxAlpha",
  "roadOpacity",
] as const;

// Thrown for the layers menu to report, and logged, since a tile error reaches no console.
function failed(log: string | null): Error {
  const error = new Error(`genus shader failed: ${log || "no log"}`);
  console.error(error.message);
  return error;
}

function compile(gl: WebGL2RenderingContext): WebGLProgram {
  const program = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, VERTEX],
    [gl.FRAGMENT_SHADER, FRAGMENT],
  ] as const) {
    const shader = gl.createShader(type);
    if (!shader) {
      throw new Error("no shader");
    }
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw failed(gl.getShaderInfoLog(shader));
    }
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.bindAttribLocation(program, 0, "point");
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw failed(gl.getProgramInfoLog(program));
  }
  return program;
}

// One stage the sources are resampled onto in turn, and one texture unit per source.
class Painter {
  readonly stage: OffscreenCanvas;
  readonly stageContext: OffscreenCanvasRenderingContext2D;
  readonly canvas: OffscreenCanvas;
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly textures: WebGLTexture[];
  private readonly uniforms: Record<
    (typeof UNIFORMS)[number],
    WebGLUniformLocation | null
  >;

  constructor(readonly size: number) {
    this.stage = new OffscreenCanvas(size, size);
    const stageContext = this.stage.getContext("2d");
    if (!stageContext) {
      throw new Error("no 2d context");
    }
    this.stageContext = stageContext;

    this.canvas = new OffscreenCanvas(size, size);
    const gl = this.canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true, // the compose reads it back after the draw has returned
    });
    if (!gl) {
      throw new Error("no webgl2");
    }
    this.gl = gl;
    this.program = compile(gl);
    gl.useProgram(this.program);
    this.uniforms = Object.fromEntries(
      UNIFORMS.map((name) => [name, gl.getUniformLocation(this.program, name)]),
    ) as Painter["uniforms"];
    for (const [unit, name] of SAMPLERS.entries()) {
      gl.uniform1i(this.uniforms[name], unit);
    }
    gl.uniform3fv(this.uniforms.linearPalette, LINEAR_PALETTE);

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]), // one oversized triangle covering the clip square
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // Data, not color: neither premultiplied nor color-converted on upload.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(
      gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,
      gl.NONE as unknown as number,
    );
    this.textures = SAMPLERS.map((_name, unit) => {
      const texture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return texture;
    });
  }

  get lost(): boolean {
    return this.gl.isContextLost();
  }

  dispose(): void {
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  // The units the current tile uploaded, which the shader samples and the rest it reads as empty.
  private present = 0;

  begin(): void {
    this.present = 0;
  }

  // Draws onto the stage at the tile's resolution, then copies the stage into a texture unit.
  stageInto(
    unit: number,
    ratio: number,
    paint: (stage: OffscreenCanvasRenderingContext2D) => void,
  ): void {
    const { gl } = this;
    this.present |= 1 << unit;
    this.stageContext.reset();
    this.stageContext.scale(ratio, ratio);
    paint(this.stageContext);
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.textures[unit]);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.stage,
    );
  }

  paint(mask: number): void {
    const { gl, size, uniforms } = this;
    const theme = themeName();
    const { canopy } = palette();
    gl.useProgram(this.program);
    gl.uniform1i(uniforms.size, size);
    gl.uniform1ui(uniforms.mask, mask);
    gl.uniform1ui(uniforms.present, this.present);
    gl.uniform1i(uniforms.dark, theme === "dark" ? 1 : 0);
    gl.uniform1f(uniforms.valueFull, canopy.valueFull);
    gl.uniform1f(uniforms.alphaFull, canopy.alphaFull);
    gl.uniform1f(uniforms.alphaCurve, canopy.alphaCurve);
    gl.uniform1f(uniforms.maxAlpha, canopy.maxAlpha);
    gl.uniform1f(uniforms.roadOpacity, ROAD_OPACITY[theme]);
    gl.viewport(0, 0, size, size);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

let painter: Painter | null = null;

function painterFor(size: number): Painter {
  if (painter?.lost) {
    painter = null; // a lost context cannot be revived, only replaced
  }
  if (painter?.size !== size) {
    painter?.dispose();
    painter = new Painter(size);
  }
  return painter;
}

interface Sources {
  layers: (Patch | null)[];
  canopy: Patch;
  streets: StreetSegment[];
}

async function patchOf(
  template: string,
  maxNativeZoom: number,
  coords: TileCoords,
): Promise<Patch | null> {
  const cut = cutFor(maxNativeZoom, coords);
  const { patch, failed } = await assemble(template, cut);
  // Thrown so the layers menu can report it; a failed neighbor only costs the resample edge context.
  if (!patch && failed) {
    throw new Error(`${template}: source tiles could not be fetched`);
  }
  return patch ? { patch, margin: cut.margin, scale: cut.scale } : null;
}

// The canopy first: bare ground draws nothing, so its genus layers and sidewalks go unfetched.
async function load(
  { url, canopyUrl, maxNativeZoom, canopyMaxNativeZoom }: GenusParams,
  coords: TileCoords,
): Promise<Sources | null> {
  const canopy = await patchOf(canopyUrl, canopyMaxNativeZoom, coords);
  if (!canopy) {
    return null;
  }
  const [layers, streets] = await Promise.all([
    Promise.all(
      Array.from({ length: LAYERS }, (_unused, layer) =>
        patchOf(url.replace("{layer}", String(layer)), maxNativeZoom, coords),
      ),
    ),
    // Only the highlight: a chunk that won't load leaves the wash under it standing.
    coords.z >= MIN_STREET_ZOOM
      ? loadStreets(coords).catch((): StreetSegment[] => [])
      : [],
  ]);
  return { layers, canopy, streets };
}

function maskOf(enabled: readonly number[]): number {
  let mask = 0;
  for (const id of enabled) {
    mask |= 1 << id;
  }
  return mask >>> 0;
}

export const genusRenderer: TileRenderer<GenusParams, Sources | null> = {
  load,
  draw(context, sources, coords, { enabled }, ratio) {
    // No canopy, no wash: its shape is the canopy's.
    if (!sources) {
      return;
    }
    const { layers, canopy, streets } = sources;
    const size = Math.round(TILE_SIZE * ratio);
    const painted = painterFor(size);
    painted.begin();
    for (const [unit, layer] of layers.entries()) {
      if (layer) {
        painted.stageInto(unit, ratio, (stage) => resample(stage, layer));
      }
    }
    painted.stageInto(CANOPY_UNIT, ratio, (stage) => resample(stage, canopy));
    if (streets.length > 0) {
      painted.stageInto(STREETS_UNIT, ratio, (stage) =>
        strokeStreets(stage, streets, coords, MASK_COLORS),
      );
    }
    painted.paint(maskOf(enabled));
    // A context lost mid-tile makes `paint` a silent no-op, and Leaflet never re-requests a drawn tile.
    if (painted.lost) {
      throw new Error("genus shader: the graphics context was lost mid-tile");
    }
    context.drawImage(painted.canvas, 0, 0, TILE_SIZE, TILE_SIZE);
  },
};
