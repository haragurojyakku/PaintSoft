/**
 * An RGBA8 texture paired with a framebuffer, so it can be both sampled and drawn into.
 *
 * Every pixel buffer in the engine — each layer, the in-progress stroke buffer, the
 * composited document — is one of these. Contents are always **premultiplied** alpha:
 * the stamp shader emits `vec4(color * a, a)` and every composite step blends with
 * `(ONE, ONE_MINUS_SRC_ALPHA)`. Keeping one convention everywhere is what lets layers,
 * strokes and the eraser share the same blend setup instead of each needing a fixup pass.
 */
export class RenderTarget {
  readonly texture: WebGLTexture;
  readonly framebuffer: WebGLFramebuffer;

  width: number;
  height: number;

  private readonly gl: WebGL2RenderingContext;

  constructor(gl: WebGL2RenderingContext, width: number, height: number) {
    this.gl = gl;
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.texture = texture;

    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`Incomplete framebuffer (0x${status.toString(16)}) for ${this.width}x${this.height} target`);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.framebuffer = framebuffer;
  }

  /** Binds this target for drawing and sets the viewport to match its full size. */
  bindAsTarget(): void {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, this.width, this.height);
  }

  clear(r = 0, g = 0, b = 0, a = 0): void {
    const { gl } = this;
    this.bindAsTarget();
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /**
   * Reallocates the backing texture at a new size, discarding contents. Callers that
   * need the old pixels (canvas resize / crop) draw the old target into the new one
   * before disposing it — that scaling decision belongs to the document layer, not here.
   */
  resize(width: number, height: number): void {
    const { gl } = this;
    const nextWidth = Math.max(1, Math.floor(width));
    const nextHeight = Math.max(1, Math.floor(height));
    if (nextWidth === this.width && nextHeight === this.height) return;

    this.width = nextWidth;
    this.height = nextHeight;

    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, nextWidth, nextHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }

  /** Reads the full target back as premultiplied RGBA bytes, top row first. */
  readPixels(): Uint8Array {
    const { gl } = this;
    const pixels = new Uint8Array(this.width * this.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels;
  }

  dispose(): void {
    const { gl } = this;
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteTexture(this.texture);
  }
}
