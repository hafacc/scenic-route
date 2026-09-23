// biome-ignore-all lint/correctness/useHookAtTopLevel: gl.useProgram is WebGL, not a React hook

import { type Channel, type Ramp, STOPS_LIMIT } from "../theme/palette";
import { type Patch, draw as resample } from "./magnify";

// Every value tile is colored here through the palette ramp, so a theme change is only a redraw.
// One shared context, since browsers cap a document at ~16; the result is composed onto the 2D tile.

const TILE_SIZE = 256;

const CHANNELS: Record<Channel, number> = { red: 0, green: 1, alpha: 3 };

const VERTEX = `#version 300 es
in vec2 point;
void main() { gl_Position = vec4(point, 0.0, 1.0); }`;

// `size - 1 - y` because gl_FragCoord counts up from the bottom and canvas rows count down.
const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D source;
uniform int size;
uniform vec3 stops[${STOPS_LIMIT}];
uniform int stopCount;
uniform int valueChannel;
uniform int alphaChannel;
uniform int reliefChannel; // negative where the layer carries no relief
uniform float valueFull;
uniform float alphaFull;
uniform float alphaCurve;
uniform float maxAlpha;
uniform float reliefScale;
out vec4 color;

float channel(vec4 pixel, int which) {
  return which == 0 ? pixel.r : which == 1 ? pixel.g : which == 2 ? pixel.b : pixel.a;
}

void main() {
  vec4 pixel = texelFetch(
    source, ivec2(int(gl_FragCoord.x), size - 1 - int(gl_FragCoord.y)), 0);
  float alpha = maxAlpha
    * pow(clamp(channel(pixel, alphaChannel) / alphaFull, 0.0, 1.0), alphaCurve);
  if (alpha <= 0.0) {
    color = vec4(0.0);
    return;
  }
  vec3 tint = stops[0];
  if (stopCount > 1) {
    float position =
      clamp(channel(pixel, valueChannel) / valueFull, 0.0, 1.0) * float(stopCount - 1);
    int low = clamp(int(floor(position)), 0, stopCount - 2);
    tint = mix(stops[low], stops[low + 1], position - float(low));
  }
  if (reliefChannel >= 0) {
    tint *= channel(pixel, reliefChannel) * reliefScale;
  }
  color = vec4(clamp(tint, 0.0, 1.0) * alpha, alpha); // premultiplied, matching the canvas
}`;

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
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.bindAttribLocation(program, 0, "point");
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? "theme shader failed");
  }
  return program;
}

// RGB on 0..1, padded to the uniform array's fixed length.
function stopsOf(ramp: Ramp): Float32Array {
  const packed = new Float32Array(STOPS_LIMIT * 3);
  for (const [index, { red, green, blue }] of ramp.stops.entries()) {
    packed.set([red / 255, green / 255, blue / 255], index * 3);
  }
  return packed;
}

class Painter {
  // Values resampled before coloring, so the ramp applies to what interpolation produced.
  readonly stage: OffscreenCanvas;
  readonly stageContext: OffscreenCanvasRenderingContext2D;
  readonly canvas: OffscreenCanvas;
  private readonly gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private readonly texture: WebGLTexture;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};

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
    this.locate();

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]), // one oversized triangle covering the clip square
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // 2D canvases store premultiplied alpha, so undo it; these are data, so no color conversion.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(
      gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,
      gl.NONE as unknown as number,
    );
  }

  private locate(): void {
    const { gl, program } = this;
    gl.useProgram(program);
    this.uniforms = Object.fromEntries(
      [
        "source",
        "size",
        "stops",
        "stopCount",
        "valueChannel",
        "alphaChannel",
        "reliefChannel",
        "valueFull",
        "alphaFull",
        "alphaCurve",
        "maxAlpha",
        "reliefScale",
      ].map((name) => [name, gl.getUniformLocation(program, name)]),
    );
    gl.uniform1i(this.uniforms.source, 0);
  }

  get lost(): boolean {
    return this.gl.isContextLost();
  }

  // Browsers cap live contexts at ~16 and reclaim the oldest, so release this one rather than wait.
  dispose(): void {
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  paint(ramp: Ramp): void {
    const { gl, size, uniforms } = this;
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.stage,
    );
    gl.uniform1i(uniforms.size, size);
    gl.uniform3fv(uniforms.stops, stopsOf(ramp));
    gl.uniform1i(uniforms.stopCount, ramp.stops.length);
    gl.uniform1i(uniforms.valueChannel, CHANNELS[ramp.value]);
    gl.uniform1i(uniforms.alphaChannel, CHANNELS[ramp.alpha]);
    gl.uniform1i(
      uniforms.reliefChannel,
      ramp.relief ? CHANNELS[ramp.relief] : -1,
    );
    gl.uniform1f(uniforms.valueFull, ramp.valueFull);
    gl.uniform1f(uniforms.alphaFull, ramp.alphaFull);
    gl.uniform1f(uniforms.alphaCurve, ramp.alphaCurve);
    gl.uniform1f(uniforms.maxAlpha, ramp.maxAlpha);
    gl.uniform1f(uniforms.reliefScale, ramp.reliefScale);
    gl.viewport(0, 0, size, size);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

let painter: Painter | null = null;

// There is no fallback path, so a card that can't do this throws for the layers menu to report.
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

// A null patch is empty ground and draws nothing.
export function drawRamped(
  context: OffscreenCanvasRenderingContext2D,
  source: Patch | null,
  ramp: Ramp,
  ratio: number,
): void {
  if (!source) {
    return;
  }
  const size = Math.round(TILE_SIZE * ratio);
  const painted = painterFor(size);
  painted.stageContext.reset();
  painted.stageContext.scale(ratio, ratio);
  resample(painted.stageContext, source);
  painted.paint(ramp);
  // A context lost mid-tile makes `paint` a silent no-op, and Leaflet never re-requests a drawn tile.
  if (painted.lost) {
    throw new Error("theme shader: the graphics context was lost mid-tile");
  }
  context.drawImage(painted.canvas, 0, 0, TILE_SIZE, TILE_SIZE);
}
