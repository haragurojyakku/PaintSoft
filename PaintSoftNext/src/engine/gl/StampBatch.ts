import { ShaderProgram } from './ShaderProgram';
import { UNIT_QUAD, type DrawDestination } from './Compositor';

/** Floats per stamp in the instance buffer: x, y, radius, alpha. */
export const STAMP_STRIDE = 4;

/**
 * How far the visible halo reaches past the nominal radius at blur = 100 (so the outer
 * radius is 2.6x the nominal one). Carried over unchanged from the v1 CPU engine: real
 * airbrush spray fans out well past the nozzle's nominal width, and a blur confined to
 * `radius` never reads as "airbrush" no matter how soft its inner falloff is.
 */
export const AIRBRUSH_SPREAD = 1.6;

export interface StampStyle {
  /** Stroke colour, each channel 0..1. Ignored for the eraser, which only needs coverage. */
  color: readonly [number, number, number];
  /** 0 = binary edge with no anti-aliasing, 100 = wide soft airbrush halo. */
  blur: number;
  /**
   * When true, overlapping stamps within one stroke darken each other (airbrush-style
   * buildup). When false, coverage is accumulated with a MAX blend so a slow stroke and
   * a fast one over the same path land at the same opacity — the behaviour most pen
   * brushes in illustration software have, and what stops a stabilised stroke from
   * silently darkening just because it emitted more stamps.
   */
  buildup: boolean;
}

const VERTEX_SOURCE = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;   // unit quad, 0..1
layout(location = 1) in vec4 aStamp;    // x, y, radius, alpha  (per instance)

uniform vec2 uTargetSize;
uniform float uSpread;

out vec2 vLocal;
out float vRadius;
out float vAlpha;

void main() {
  // +1px guard band so the outermost row of the falloff (or the hard edge sitting exactly
  // at the nominal radius) is never clipped by the quad's own boundary.
  float outer = aStamp.z * uSpread + 1.0;
  vec2 offset = (aCorner - 0.5) * 2.0 * outer;

  vLocal = offset;
  vRadius = aStamp.z;
  vAlpha = aStamp.w;

  vec2 pos = aStamp.xy + offset;
  gl_Position = vec4((pos / uTargetSize) * 2.0 - 1.0, 0.0, 1.0);
}
`;

const FRAGMENT_SOURCE = /* glsl */ `#version 300 es
precision highp float;

in vec2 vLocal;
in float vRadius;
in float vAlpha;

uniform vec3 uColor;
uniform float uSpread;
uniform float uCoreFraction;
uniform bool uHardEdge;

out vec4 fragColor;

void main() {
  float dist = length(vLocal);
  float coverage;

  if (uHardEdge) {
    // blur = 0 is a genuinely binary edge: a pixel centre is either inside the disc or
    // it is not, with no blending at the rim. The radius floor of 0.5 keeps a hairline
    // brush from falling between pixel centres and stamping nothing at all.
    coverage = step(dist, max(vRadius, 0.5));
  } else {
    // Analytic version of v1's radial gradient: a solid core out to uCoreFraction, then
    // a quadratic falloff to zero at the outer radius. v1 approximated this curve with
    // five gradient colour stops per stamp; evaluating it per fragment is both exact and
    // free of the per-stamp CanvasGradient allocation that made large soft brushes slow.
    float d = dist / (vRadius * uSpread);
    float t = (d - uCoreFraction) / max(1e-5, 1.0 - uCoreFraction);
    coverage = d <= uCoreFraction ? 1.0 : (t >= 1.0 ? 0.0 : (1.0 - t) * (1.0 - t));
  }

  float a = coverage * vAlpha;
  if (a <= 0.0) discard;

  fragColor = vec4(uColor * a, a);
}
`;

/**
 * Draws every stamp of a stroke segment as a single instanced draw call.
 *
 * This is the core of the rebuild's performance story. v1 issued one `ctx.fill()` per
 * stamp and, for any non-zero blur, allocated a fresh CanvasGradient per stamp too, so
 * cost scaled with stamp count on the CPU. Here the stamp positions are uploaded as one
 * instance buffer and the brush profile is evaluated in the fragment shader, so a
 * thousand stamps and one stamp are the same number of draw calls, and a large brush
 * costs GPU fill rate rather than CPU time.
 */
export class StampBatch {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: ShaderProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly quadBuffer: WebGLBuffer;
  private readonly instanceBuffer: WebGLBuffer;

  private instanceCapacity = 0;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = new ShaderProgram(gl, VERTEX_SOURCE, FRAGMENT_SOURCE, 'stamp');

    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, UNIT_QUAD, gl.STATIC_DRAW);

    this.instanceBuffer = gl.createBuffer();

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, STAMP_STRIDE * 4, 0);
    gl.vertexAttribDivisor(1, 1);

    gl.bindVertexArray(null);
  }

  /**
   * @param stamps Packed [x, y, radius, alpha] per stamp, in destination pixel space.
   * @param count  Number of stamps to read from the start of `stamps`.
   */
  draw(dest: DrawDestination, stamps: Float32Array, count: number, style: StampStyle): void {
    if (count <= 0) return;

    const { gl } = this;
    const t = Math.max(0, Math.min(100, style.blur)) / 100;
    const spread = 1 + t * AIRBRUSH_SPREAD;

    this.uploadInstances(stamps, count);

    gl.bindFramebuffer(gl.FRAMEBUFFER, dest.framebuffer);
    gl.viewport(0, 0, dest.width, dest.height);
    // Each stamp quad already bounds its own writes, and the compositor leaves a scissor
    // box set from the previous dirty-rect pass — inheriting it here would silently clip
    // stamps that fall outside the *previous* frame's dirty region.
    gl.disable(gl.SCISSOR_TEST);

    gl.enable(gl.BLEND);
    if (style.buildup) {
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    } else {
      // MIN/MAX ignore the blend func entirely, so the result is componentwise
      // max(src, dst). With a constant stroke colour that is consistent across the
      // premultiplied channels: max(c*a1, c*a2) == c * max(a1, a2).
      gl.blendEquation(gl.MAX);
      gl.blendFunc(gl.ONE, gl.ONE);
    }

    this.program.use();
    gl.uniform2f(this.program.uniform('uTargetSize'), dest.width, dest.height);
    gl.uniform3f(this.program.uniform('uColor'), style.color[0], style.color[1], style.color[2]);
    gl.uniform1f(this.program.uniform('uSpread'), spread);
    // coreFraction = ((1 - t) * radius) / (radius * spread) — the radius cancels, so the
    // core is the same fraction of the outer radius for every stamp and can be a uniform.
    gl.uniform1f(this.program.uniform('uCoreFraction'), (1 - t) / spread);
    gl.uniform1i(this.program.uniform('uHardEdge'), t < 0.005 ? 1 : 0);

    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.bindVertexArray(null);

    gl.blendEquation(gl.FUNC_ADD);
  }

  private uploadInstances(stamps: Float32Array, count: number): void {
    const { gl } = this;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);

    if (count > this.instanceCapacity) {
      // Grow in powers of two so a stroke that ramps up in speed doesn't reallocate
      // every frame, and orphan the old storage rather than stalling on it.
      this.instanceCapacity = Math.max(256, nextPowerOfTwo(count));
      gl.bufferData(gl.ARRAY_BUFFER, this.instanceCapacity * STAMP_STRIDE * 4, gl.DYNAMIC_DRAW);
    }

    gl.bufferSubData(gl.ARRAY_BUFFER, 0, stamps, 0, count * STAMP_STRIDE);
  }

  dispose(): void {
    this.gl.deleteBuffer(this.quadBuffer);
    this.gl.deleteBuffer(this.instanceBuffer);
    this.gl.deleteVertexArray(this.vao);
    this.program.dispose();
  }
}

function nextPowerOfTwo(value: number): number {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}
