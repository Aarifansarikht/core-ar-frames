import type { WebGLRenderer } from 'three';

const VERTEX = `#version 300 es
out vec2 uv;
void main() {
  uv = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision mediump float;
uniform sampler2D image;
in vec2 uv;
out vec4 color;
void main() { color = texture(image, uv); }`;

/**
 * Copies ARCore's camera image out of the GPU without stalling rendering. The read goes into a pixel
 * buffer behind a fence and is collected on a later frame, once the GPU has actually finished it.
 */
export class CameraReadback {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly framebuffer: WebGLFramebuffer;
  private readonly target: WebGLTexture;
  private readonly buffer: WebGLBuffer;
  private width = 0;
  private height = 0;
  private fence: WebGLSync | null = null;

  constructor(private readonly renderer: WebGLRenderer) {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    this.gl = gl;
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return shader;
    };
    this.program = gl.createProgram()!;
    gl.attachShader(this.program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(this.program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(this.program);
    this.vao = gl.createVertexArray()!;
    this.framebuffer = gl.createFramebuffer()!;
    this.target = gl.createTexture()!;
    this.buffer = gl.createBuffer()!;
  }

  get pending() {
    return this.fence !== null;
  }

  /** Starts copying `source`, scaled to this size. Must run inside the XR frame that owns the texture. */
  capture(source: WebGLTexture, width: number, height: number) {
    const { gl, renderer } = this;
    // three.js has set its XR render target by now, and resetting its state would otherwise lose it.
    const renderTarget = renderer.getRenderTarget();

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.activeTexture(gl.TEXTURE0);
    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
      gl.bindTexture(gl.TEXTURE_2D, this.target);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.target, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buffer);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, width * height * 4, gl.STREAM_READ);
    }
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.bindTexture(gl.TEXTURE_2D, source);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buffer);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();

    gl.bindVertexArray(null);
    renderer.resetState();
    renderer.setRenderTarget(renderTarget);
  }

  /** The finished image, or null if the GPU isn't done with it yet. */
  collect() {
    const { gl } = this;
    if (!this.fence || gl.clientWaitSync(this.fence, 0, 0) === gl.TIMEOUT_EXPIRED) return null;
    gl.deleteSync(this.fence);
    this.fence = null;
    const pixels = new Uint8Array(this.width * this.height * 4);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buffer);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, pixels);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return pixels;
  }

  dispose() {
    const { gl } = this;
    if (this.fence) gl.deleteSync(this.fence);
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteTexture(this.target);
    gl.deleteBuffer(this.buffer);
  }
}
