/**
 * Minimal WebGL2 program wrapper: compiles a vertex/fragment pair and caches
 * uniform locations so hot render paths never call getUniformLocation.
 */
export class ShaderProgram {
  readonly program: WebGLProgram;

  private readonly gl: WebGL2RenderingContext;
  private readonly uniformCache = new Map<string, WebGLUniformLocation | null>();

  constructor(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string, label = 'program') {
    this.gl = gl;

    const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource, `${label}.vert`);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource, `${label}.frag`);

    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);

    // The shaders are already linked into the program at this point; deleting the
    // objects here just drops our reference so the driver can free them with the
    // program rather than keeping them alive for the context's lifetime.
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`Failed to link ${label}: ${log ?? '(no log)'}`);
    }

    this.program = program;
  }

  use(): void {
    this.gl.useProgram(this.program);
  }

  uniform(name: string): WebGLUniformLocation | null {
    let location = this.uniformCache.get(name);
    if (location === undefined) {
      location = this.gl.getUniformLocation(this.program, name);
      this.uniformCache.set(name, location);
    }
    return location;
  }

  dispose(): void {
    this.gl.deleteProgram(this.program);
    this.uniformCache.clear();
  }
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
  label: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error(`Failed to create shader object for ${label}`);

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Failed to compile ${label}: ${log ?? '(no log)'}\n\n${withLineNumbers(source)}`);
  }

  return shader;
}

function withLineNumbers(source: string): string {
  return source
    .split('\n')
    .map((line, i) => `${String(i + 1).padStart(3, ' ')} | ${line}`)
    .join('\n');
}
