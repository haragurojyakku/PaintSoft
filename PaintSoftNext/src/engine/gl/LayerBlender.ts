import { blendModeIndex, type LayerBlendMode } from '../blendModes';
import { UNIT_QUAD, type DrawDestination } from './Compositor';
import { ShaderProgram } from './ShaderProgram';

const VERTEX_SOURCE = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
out vec2 vUV;

void main() {
  vUV = aCorner;
  gl_Position = vec4(aCorner * 2.0 - 1.0, 0.0, 1.0);
}
`;

const FRAGMENT_SOURCE = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUV;

uniform sampler2D uBackdrop;
uniform sampler2D uSource;
uniform sampler2D uMask;
uniform float uOpacity;
uniform int uMode;
uniform bool uUseMask;

out vec4 fragColor;

float dodge(float b, float s) {
  if (b <= 0.0) return 0.0;
  if (s >= 1.0) return 1.0;
  return min(1.0, b / (1.0 - s));
}

float burn(float b, float s) {
  if (b >= 1.0) return 1.0;
  if (s <= 0.0) return 0.0;
  return 1.0 - min(1.0, (1.0 - b) / s);
}

float hardLight(float b, float s) {
  return s <= 0.5 ? 2.0 * b * s : 1.0 - 2.0 * (1.0 - b) * (1.0 - s);
}

float softLight(float b, float s) {
  if (s <= 0.5) return b - (1.0 - 2.0 * s) * b * (1.0 - b);
  float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
  return b + (2.0 * s - 1.0) * (d - b);
}

vec3 blend(vec3 b, vec3 s, int mode) {
  if (mode == 1) return b * s;
  if (mode == 2) return b + s - b * s;
  if (mode == 3) return vec3(hardLight(s.r, b.r), hardLight(s.g, b.g), hardLight(s.b, b.b));
  if (mode == 4) return min(b, s);
  if (mode == 5) return max(b, s);
  if (mode == 6) return vec3(dodge(b.r, s.r), dodge(b.g, s.g), dodge(b.b, s.b));
  if (mode == 7) return vec3(burn(b.r, s.r), burn(b.g, s.g), burn(b.b, s.b));
  if (mode == 8) return vec3(hardLight(b.r, s.r), hardLight(b.g, s.g), hardLight(b.b, s.b));
  if (mode == 9) return vec3(softLight(b.r, s.r), softLight(b.g, s.g), softLight(b.b, s.b));
  if (mode == 10) return abs(b - s);
  if (mode == 11) return b + s - 2.0 * b * s;
  return s;
}

void main() {
  vec4 dst = texture(uBackdrop, vUV);
  // The mask scales the source's alpha (and, being premultiplied, its colour with it), so
  // a clipped layer simply stops existing outside its base's silhouette.
  float mask = uUseMask ? texture(uMask, vUV).a : 1.0;
  vec4 src = texture(uSource, vUV) * (uOpacity * mask);

  // Blend functions are defined on straight (un-premultiplied) colours, so both inputs are
  // divided out here and the result is re-premultiplied at the end.
  vec3 cs = src.a > 0.0 ? src.rgb / src.a : vec3(0.0);
  vec3 cb = dst.a > 0.0 ? dst.rgb / dst.a : vec3(0.0);

  vec3 mixed = blend(cb, cs, uMode);

  // W3C compositing: where the backdrop is transparent the source shows through unblended,
  // which is what stops a multiply layer over empty canvas from turning into a black hole.
  vec3 co = src.a * (1.0 - dst.a) * cs + src.a * dst.a * mixed + (1.0 - src.a) * dst.a * cb;
  float ao = src.a + dst.a * (1.0 - src.a);

  fragColor = vec4(co, ao);
}
`;

/**
 * Applies a layer over a backdrop using a blend mode that fixed-function blending cannot
 * express.
 *
 * Anything beyond 'normal' needs to read the destination, so this reads the backdrop as a
 * *texture* and writes to a different target — the caller ping-pongs. That is why the
 * engine keeps 'normal' on the cheap `Compositor` path: the overwhelmingly common case
 * stays a single blended draw with no extra full-canvas pass.
 */
export class LayerBlender {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: ShaderProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly quadBuffer: WebGLBuffer;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = new ShaderProgram(gl, VERTEX_SOURCE, FRAGMENT_SOURCE, 'layer-blend');

    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, UNIT_QUAD, gl.STATIC_DRAW);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  draw(
    dest: DrawDestination,
    backdrop: WebGLTexture,
    source: WebGLTexture,
    mode: LayerBlendMode,
    opacity: number,
    mask?: WebGLTexture,
  ): void {
    const { gl } = this;

    gl.bindFramebuffer(gl.FRAMEBUFFER, dest.framebuffer);
    gl.viewport(0, 0, dest.width, dest.height);
    gl.disable(gl.SCISSOR_TEST);
    // The shader produces the final composite itself, so hardware blending must be off or
    // it would combine that result with whatever the destination already held.
    gl.disable(gl.BLEND);

    this.program.use();
    gl.uniform1f(this.program.uniform('uOpacity'), opacity);
    gl.uniform1i(this.program.uniform('uMode'), blendModeIndex(mode));

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, backdrop);
    gl.uniform1i(this.program.uniform('uBackdrop'), 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, source);
    gl.uniform1i(this.program.uniform('uSource'), 1);

    // The sampler must point at a real texture even when unused, or some drivers sample
    // undefined data rather than the 1.0 the branch is supposed to produce.
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, mask ?? source);
    gl.uniform1i(this.program.uniform('uMask'), 2);
    gl.uniform1i(this.program.uniform('uUseMask'), mask ? 1 : 0);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);

    gl.activeTexture(gl.TEXTURE0);
  }

  dispose(): void {
    this.gl.deleteBuffer(this.quadBuffer);
    this.gl.deleteVertexArray(this.vao);
    this.program.dispose();
  }
}
