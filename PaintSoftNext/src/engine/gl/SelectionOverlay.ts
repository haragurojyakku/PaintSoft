import { UNIT_QUAD, type DrawDestination, type Rect } from './Compositor';
import { ShaderProgram } from './ShaderProgram';

const VERTEX_SOURCE = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;

uniform vec4 uDestRect;
uniform vec2 uDestSize;

out vec2 vUV;

void main() {
  vec2 pos = uDestRect.xy + aCorner * uDestRect.zw;
  vec2 ndc = (pos / uDestSize) * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  vUV = aCorner;
}
`;

const FRAGMENT_SOURCE = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUV;

uniform sampler2D uSelection;
uniform vec2 uTexelSize;
uniform float uDashScale;

out vec4 fragColor;

float coverage(vec2 uv) {
  return texture(uSelection, uv).r;
}

void main() {
  float here = coverage(vUV);

  // Edge detection against the four neighbours: the boundary is wherever coverage changes.
  // Comparing against a 0.5 threshold rather than the raw values keeps an anti-aliased
  // lasso edge from painting a band several pixels wide.
  float inside = step(0.5, here);
  float outline = 0.0;
  outline = max(outline, abs(inside - step(0.5, coverage(vUV + vec2(uTexelSize.x, 0.0)))));
  outline = max(outline, abs(inside - step(0.5, coverage(vUV - vec2(uTexelSize.x, 0.0)))));
  outline = max(outline, abs(inside - step(0.5, coverage(vUV + vec2(0.0, uTexelSize.y)))));
  outline = max(outline, abs(inside - step(0.5, coverage(vUV - vec2(0.0, uTexelSize.y)))));

  if (outline < 0.5) discard;

  // Dashes are keyed to screen position, not document position, so they stay the same
  // visible size at every zoom level.
  float dash = mod(floor((gl_FragCoord.x + gl_FragCoord.y) / uDashScale), 2.0);
  fragColor = vec4(vec3(dash), 1.0);
}
`;

/**
 * Draws the "marching ants" boundary of the active selection over the presented canvas.
 *
 * Derived from the mask each frame rather than kept as a path, so it stays correct however
 * the selection was built — rectangle, lasso, inverted, or combined out of several of them.
 * The dashes are static; they mark the boundary without the animation loop a moving pattern
 * would force the renderer into.
 */
export class SelectionOverlay {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: ShaderProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly quadBuffer: WebGLBuffer;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = new ShaderProgram(gl, VERTEX_SOURCE, FRAGMENT_SOURCE, 'selection-overlay');

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
    selection: WebGLTexture,
    rect: Rect,
    documentWidth: number,
    documentHeight: number,
  ): void {
    const { gl } = this;

    gl.bindFramebuffer(gl.FRAMEBUFFER, dest.framebuffer);
    gl.viewport(0, 0, dest.width, dest.height);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);

    this.program.use();
    gl.uniform4f(this.program.uniform('uDestRect'), rect.x, rect.y, rect.width, rect.height);
    gl.uniform2f(this.program.uniform('uDestSize'), dest.width, dest.height);
    gl.uniform2f(this.program.uniform('uTexelSize'), 1 / documentWidth, 1 / documentHeight);
    gl.uniform1f(this.program.uniform('uDashScale'), 4);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, selection);
    gl.uniform1i(this.program.uniform('uSelection'), 0);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    this.gl.deleteBuffer(this.quadBuffer);
    this.gl.deleteVertexArray(this.vao);
    this.program.dispose();
  }
}
