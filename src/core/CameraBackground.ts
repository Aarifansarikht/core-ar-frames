import {
  LinearFilter,
  Mesh,
  NoColorSpace,
  PlaneGeometry,
  ShaderMaterial,
  Texture,
  Vector2,
  type WebGLRenderer,
} from 'three';
import backgroundVert from '../shaders/cameraBackground.vert.glsl?raw';
import backgroundFrag from '../shaders/cameraBackground.frag.glsl?raw';

/**
 * A video texture uploaded only on request. Taking Three's video path means uploads use the frame's
 * intrinsic size, which can change on rotation, where a plain Texture would allocate fixed storage from
 * the element's width and height attributes. VideoTexture itself can't be used because it uploads each
 * new frame on its own, and frame locking needs to choose the moment.
 */
class ManualVideoTexture extends Texture {
  readonly isVideoTexture = true;

  update() {
    // Called by the renderer every frame. Uploads happen only through needsUpdate in capture().
  }
}

/**
 * Draws the camera feed in the WebGL frame instead of behind a transparent canvas, because a separate
 * <video> layer composites on its own clock and overlays visibly swim against it.
 *
 * It keeps two textures so tracking can upload a frame up front, solve its pose asynchronously, and
 * only then show the frame and pose together.
 */
export class CameraBackground {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private readonly textures: [Texture, Texture];
  private frontIndex = 0;
  private pendingCapture = false;

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly video: HTMLVideoElement,
  ) {
    this.textures = [this.makeTexture(), this.makeTexture()];
    this.material = new ShaderMaterial({
      vertexShader: backgroundVert,
      fragmentShader: backgroundFrag,
      uniforms: {
        map: { value: this.textures[0] },
        uvScale: { value: new Vector2(1, 1) },
      },
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.mesh = new Mesh(new PlaneGeometry(2, 2), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.visible = false;
  }

  /** Uploads the current camera frame to the back texture. Nothing changes on screen yet. */
  capture() {
    if (!this.video.videoWidth) return;
    const back = this.textures[1 - this.frontIndex];
    back.needsUpdate = true;
    this.renderer.initTexture(back);
    this.pendingCapture = true;
  }

  /** Shows the most recently captured frame. */
  present() {
    if (!this.pendingCapture) return;
    this.pendingCapture = false;
    this.frontIndex = 1 - this.frontIndex;
    this.material.uniforms.map.value = this.textures[this.frontIndex];
    this.mesh.visible = true;
  }

  /** `scale` < 1 on an axis crops that axis, for object-fit: cover behaviour. */
  setUvScale(x: number, y: number) {
    (this.material.uniforms.uvScale.value as Vector2).set(x, y);
  }

  dispose() {
    this.textures.forEach((t) => t.dispose());
    this.material.dispose();
    this.mesh.geometry.dispose();
  }

  private makeTexture() {
    const texture = new ManualVideoTexture(this.video);
    texture.generateMipmaps = false;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    // Camera sRGB goes straight to display sRGB, with no decode/encode round trip per pixel.
    texture.colorSpace = NoColorSpace;
    return texture;
  }
}
