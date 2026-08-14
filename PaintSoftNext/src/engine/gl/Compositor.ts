import { identity, type Mat3 } from '../../core/mat3';
import { ShaderProgram } from './ShaderProgram';
import type { RenderTarget } from './RenderTarget';

const IDENTITY = identity();

/**
 * Anything that can be drawn into. `framebuffer: null` means the default framebuffer,
 * i.e. the on-screen canvas — the one destination whose Y axis runs the opposite way
 * from our textures (see the position flip in `draw` below).
 */
export interface DrawDestination {
  readonly framebuffer: WebGLFramebuffer | null;
  readonly width: number;
  readonly height: number;
}

export type BlendMode =
  /** Standard premultiplied source-over. */
  | 'normal'
  /** Blending off — the source overwrites the destination, used for layer→scratch copies. */
  | 'replace'
  /** Premultiplied destination-out: the source's alpha carves a hole in the destination. */
  | 'erase';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DrawTextureOptions {
  opacity?: number;
  blend?: BlendMode;
  /** Destination rect in pixels, Y down. Defaults to covering the whole destination. */
  rect?: Rect;
  /**
   * Restricts drawing to this rect of the destination, in the same Y-down pixel space as
   * `rect`. Texture destinations only — their texel rows already run the same way as the
   * scissor box, whereas the screen's do not. This is what keeps per-frame stroke work
   * proportional to the area the brush actually touched rather than to the canvas size.
   */
  scissor?: Rect;
  /** LINEAR when true (smooth minification), NEAREST when false (crisp pixels when zoomed in). */
  smooth?: boolean;
  /**
   * A texture whose **red** channel scales the source. Two things use it:
   *
   * - the active selection, applied where the stroke buffer meets the layer, so painting
   *   and erasing are confined through one code path rather than per tool;
   * - a layer mask, applied to the layer's pixels before they are composited.
   *
   * Red rather than alpha so a single-channel R8 selection and an RGBA greyscale mask can
   * both drive it. A mask painted white reads 1 and a mask painted black reads 0.
   */
  coverageMask?: WebGLTexture | undefined;
  /**
   * Affine transform applied to the destination rect, in the same Y-down pixel space.
   * Used by the transform tool to move, scale and rotate floating pixels without ever
   * resampling them into a new buffer until the edit is committed.
   */
  transform?: Mat3 | undefined;
}

const VERTEX_SOURCE = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;

uniform vec4 uDestRect;   // x, y, width, height — destination pixels, Y down
uniform vec2 uDestSize;
uniform float uFlipY;     // 1.0 when drawing to the screen, 0.0 when drawing to a texture
uniform mat3 uTransform;  // affine applied in destination pixel space; identity by default

out vec2 vUV;

void main() {
  vec2 rectPos = uDestRect.xy + aCorner * uDestRect.zw;
  vec2 pos = (uTransform * vec3(rectPos, 1.0)).xy;
  vec2 ndc = (pos / uDestSize) * 2.0 - 1.0;

  // Textures store row 0 at NDC y = -1, so a texture destination needs no flip and
  // dest-pixel Y maps straight onto texel rows. The screen is the other way up, so
  // there the Y axis is inverted here (and only here) to put document row 0 on top.
  gl_Position = vec4(ndc.x, mix(ndc.y, -ndc.y, uFlipY), 0.0, 1.0);
  vUV = aCorner;
}
`;

const FRAGMENT_SOURCE = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUV;

uniform sampler2D uTexture;
uniform sampler2D uCoverage;
uniform float uOpacity;
uniform bool uUseCoverage;

out vec4 fragColor;

void main() {
  float coverage = uUseCoverage ? texture(uCoverage, vUV).r : 1.0;
  // Premultiplied throughout, so a uniform scale of all four channels is exactly
  // "make this layer more transparent" — no un-premultiply round trip needed.
  fragColor = texture(uTexture, vUV) * (uOpacity * coverage);
}
`;

/** Draws textured quads: layer→document, document→screen, layer→scratch. */
export class Compositor {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: ShaderProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly quadBuffer: WebGLBuffer;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = new ShaderProgram(gl, VERTEX_SOURCE, FRAGMENT_SOURCE, 'compositor');

    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, UNIT_QUAD, gl.STATIC_DRAW);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  draw(dest: DrawDestination, texture: WebGLTexture, options: DrawTextureOptions = {}): void {
    const { gl } = this;
    const { opacity = 1, blend = 'normal', smooth = true } = options;
    const rect = options.rect ?? { x: 0, y: 0, width: dest.width, height: dest.height };

    gl.bindFramebuffer(gl.FRAMEBUFFER, dest.framebuffer);
    gl.viewport(0, 0, dest.width, dest.height);

    if (!applyScissor(gl, dest, options.scissor)) return;
    applyBlendMode(gl, blend);

    this.program.use();
    gl.uniform4f(this.program.uniform('uDestRect'), rect.x, rect.y, rect.width, rect.height);
    gl.uniform2f(this.program.uniform('uDestSize'), dest.width, dest.height);
    gl.uniform1f(this.program.uniform('uFlipY'), dest.framebuffer === null ? 1 : 0);
    gl.uniform1f(this.program.uniform('uOpacity'), opacity);
    gl.uniform1i(this.program.uniform('uTexture'), 0);
    gl.uniformMatrix3fv(this.program.uniform('uTransform'), false, options.transform ?? IDENTITY);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    const filter = smooth ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);

    // Bound to a real texture even when unused: some drivers sample undefined data from an
    // unbound sampler rather than honouring the branch that skips it.
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, options.coverageMask ?? texture);
    gl.uniform1i(this.program.uniform('uCoverage'), 1);
    gl.uniform1i(this.program.uniform('uUseCoverage'), options.coverageMask ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  /** Convenience for the common full-surface texture→texture copy. */
  copy(dest: RenderTarget, texture: WebGLTexture): void {
    this.draw(dest, texture, { blend: 'replace' });
  }

  dispose(): void {
    this.gl.deleteBuffer(this.quadBuffer);
    this.gl.deleteVertexArray(this.vao);
    this.program.dispose();
  }
}

/**
 * Sets (or clears) the scissor box. Returns false when the rect clips away to nothing,
 * so the caller can skip the draw entirely. Rects are snapped outward to whole pixels —
 * a stroke's bounding box is fractional, and rounding inward would shave the outermost
 * row of the brush's falloff.
 */
export function applyScissor(
  gl: WebGL2RenderingContext,
  dest: DrawDestination,
  scissor: Rect | undefined,
): boolean {
  if (!scissor || dest.framebuffer === null) {
    gl.disable(gl.SCISSOR_TEST);
    return true;
  }

  const x = Math.max(0, Math.floor(scissor.x));
  const y = Math.max(0, Math.floor(scissor.y));
  const right = Math.min(dest.width, Math.ceil(scissor.x + scissor.width));
  const bottom = Math.min(dest.height, Math.ceil(scissor.y + scissor.height));
  if (right <= x || bottom <= y) return false;

  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(x, y, right - x, bottom - y);
  return true;
}

export function applyBlendMode(gl: WebGL2RenderingContext, mode: BlendMode): void {
  if (mode === 'replace') {
    gl.disable(gl.BLEND);
    return;
  }

  gl.enable(gl.BLEND);
  gl.blendEquation(gl.FUNC_ADD);
  if (mode === 'erase') {
    gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
  } else {
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }
}

export const UNIT_QUAD = new Float32Array([
  0, 0,
  1, 0,
  0, 1,
  1, 1,
]);
