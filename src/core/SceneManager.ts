import {
  ACESFilmicToneMapping,
  Group,
  LinearFilter,
  type Matrix4,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  Texture,
  Timer,
  Vector2,
  VideoTexture,
  WebGLRenderer,
} from 'three';
import { PerformanceManager, type QualityProfile } from './PerformanceManager';

export interface SceneListener {
  contextLost?(): void;
}

export type FrameCallback = (dt: number, time: number) => void;

const NEAR = 0.01;
const FAR = 100;

/**
 * The renderer. Holds the single animation loop in the app, the camera image behind everything, and the
 * content anchor that the tracker positions through a pose matrix.
 */
export class SceneManager {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera();
  /** Content frame: poster width 1, origin at the poster's centre, +Y up, +Z out of the poster. */
  readonly anchor = new Group();
  readonly performance: PerformanceManager;

  private readonly timer = new Timer();
  private readonly frameCallbacks = new Set<FrameCallback>();
  private readonly resizeObserver: ResizeObserver;
  private listener: SceneListener = {};
  private contextLost = false;
  private disposed = false;

  private readonly backgroundScene = new Scene();
  private readonly backgroundCamera = new PerspectiveCamera();
  private readonly background: ShaderMaterial;
  private live: VideoTexture | null = null;
  private readonly frameTexture = new Texture();
  private shownFrame: ImageBitmap | null = null;
  private imageWidth = 0;
  private imageHeight = 0;
  /** The lens: focal length, and the image size that it is in pixels of. */
  private lens: { width: number; height: number; focal: number } | null = null;

  constructor(
    private readonly container: HTMLElement,
    quality: QualityProfile,
  ) {
    this.renderer = new WebGLRenderer({
      antialias: false, // At phone pixel density it costs far more than it shows.
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false,
    });
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;

    const canvas = this.renderer.domElement;
    canvas.className = 'ar-canvas';
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    container.appendChild(canvas);

    // Fills the screen, cropping the image to fit. No colour conversion: the camera's values go straight out.
    this.frameTexture.minFilter = LinearFilter;
    this.frameTexture.magFilter = LinearFilter;
    this.frameTexture.generateMipmaps = false;
    this.frameTexture.flipY = false;
    this.background = new ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      uniforms: { map: { value: null }, crop: { value: new Vector2(1, 1) }, flip: { value: 0 } },
      vertexShader: `
        varying vec2 vUv;
        uniform vec2 crop;
        uniform float flip;
        void main() {
          vec2 cropped = (uv - 0.5) * crop + 0.5;
          vUv = vec2(cropped.x, flip > 0.5 ? 1.0 - cropped.y : cropped.y);
          gl_Position = vec4(position.xy * 2.0, 0.0, 1.0);
        }`,
      fragmentShader: `
        varying vec2 vUv;
        uniform sampler2D map;
        void main() { gl_FragColor = texture2D(map, vUv); }`,
    });
    const quad = new Mesh(new PlaneGeometry(1, 1), this.background);
    quad.frustumCulled = false;
    this.backgroundScene.add(quad);

    this.performance = new PerformanceManager(quality, (ratio) => {
      this.renderer.setPixelRatio(ratio);
      this.syncSize();
    });
    this.renderer.setPixelRatio(this.performance.pixelRatio);

    this.anchor.matrixAutoUpdate = false;
    this.anchor.visible = false;
    this.scene.add(this.anchor);

    this.resizeObserver = new ResizeObserver(() => this.syncSize());
    this.resizeObserver.observe(container);
    this.syncSize();

    this.timer.connect(document);
    this.renderer.setAnimationLoop(this.tick);
  }

  setListener(listener: SceneListener) {
    this.listener = listener;
  }

  onFrame(callback: FrameCallback) {
    this.frameCallbacks.add(callback);
    return () => this.frameCallbacks.delete(callback);
  }

  /** Applies a tracker pose to the content anchor. */
  setAnchorPose(matrix: Matrix4) {
    this.anchor.matrix.copy(matrix);
    this.anchor.matrixWorldNeedsUpdate = true;
  }

  /** Shows the camera as it arrives. */
  showLiveCamera(video: HTMLVideoElement) {
    if (!this.live) this.live = new VideoTexture(video);
    if (this.live.image !== video) this.live.image = video;
    this.releaseFrame();
    this.background.uniforms.map.value = this.live;
    // Three.js flips video as it uploads it, so unlike a bitmap it doesn't need flipping here.
    this.background.uniforms.flip.value = 0;
    this.imageWidth = video.videoWidth;
    this.imageHeight = video.videoHeight;
    this.updateCrop();
  }

  /** Shows one frame, which this now owns. Draws with the pose worked out from that same frame. */
  showFrame(frame: ImageBitmap) {
    this.releaseFrame();
    this.shownFrame = frame;
    this.frameTexture.image = frame;
    this.frameTexture.needsUpdate = true;
    this.background.uniforms.map.value = this.frameTexture;
    // Browsers ignore the flip setting when uploading a bitmap, so it arrives top row first.
    this.background.uniforms.flip.value = 1;
    this.imageWidth = frame.width;
    this.imageHeight = frame.height;
    this.updateCrop();
  }

  /**
   * Sets the lens: an image of this size, at this focal length, filling the screen as the background does.
   * Everything drawn then lines up with the camera image.
   */
  setProjection(imageWidth: number, imageHeight: number, focal: number) {
    this.lens = { width: imageWidth, height: imageHeight, focal };
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    const fill = Math.max(w / imageWidth, h / imageHeight);
    const a = (2 * focal * fill) / w;
    const b = (2 * focal * fill) / h;
    this.camera.projectionMatrix.set(
      a, 0, 0, 0,
      0, b, 0, 0,
      0, 0, -(FAR + NEAR) / (FAR - NEAR), (-2 * FAR * NEAR) / (FAR - NEAR),
      0, 0, -1, 0,
    );
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
  }

  /** For room placement: a camera at a fixed height, whose lens is assumed. */
  setRoomCamera(video: HTMLVideoElement, focalFraction: number, height: number) {
    this.camera.position.set(0, height, 0);
    this.setProjection(video.videoWidth, video.videoHeight, focalFraction * Math.max(video.videoWidth, video.videoHeight));
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.timer.dispose();
    this.frameCallbacks.clear();
    this.releaseFrame();
    this.live?.dispose();
    this.frameTexture.dispose();
    this.background.dispose();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    canvas.remove();
  }

  private releaseFrame() {
    this.shownFrame?.close();
    this.shownFrame = null;
  }

  private updateCrop() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h || !this.imageWidth || !this.imageHeight) return;
    const fill = Math.max(w / this.imageWidth, h / this.imageHeight);
    this.background.uniforms.crop.value.set(w / (this.imageWidth * fill), h / (this.imageHeight * fill));
  }

  private syncSize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.updateCrop();
    if (this.lens) this.setProjection(this.lens.width, this.lens.height, this.lens.focal);
  }

  private readonly tick = () => {
    if (this.contextLost) return;
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    const time = this.timer.getElapsed();
    this.performance.frame(dt);
    for (const callback of this.frameCallbacks) callback(dt, time);
    this.renderer.clear();
    this.renderer.render(this.backgroundScene, this.backgroundCamera);
    this.renderer.clearDepth();
    this.renderer.render(this.scene, this.camera);
  };

  private readonly onContextLost = (event: Event) => {
    event.preventDefault(); // Without this the browser never restores the context.
    this.contextLost = true;
    this.listener.contextLost?.();
  };
}
