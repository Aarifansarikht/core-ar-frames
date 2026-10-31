import {
  ACESFilmicToneMapping,
  Group,
  type Matrix4,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Timer,
  WebGLRenderer,
} from 'three';
import type { CameraIntrinsics } from '../types/ar';
import { CameraBackground } from './CameraBackground';
import { PerformanceManager, type QualityProfile } from './PerformanceManager';

export interface SceneListener {
  contextLost?(): void;
}

export type FrameCallback = (dt: number, time: number, xrFrame: XRFrame | undefined) => void;

/**
 * The renderer shared by every tracking engine. Holds the single animation loop in the app, and the
 * content anchor that trackers position through a pose matrix.
 */
export class SceneManager {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera();
  /** Content frame: poster width 1, origin at the poster's centre, +Y up, +Z out of the poster. */
  readonly anchor = new Group();
  readonly background: CameraBackground;
  readonly performance: PerformanceManager;

  private readonly timer = new Timer();
  private readonly frameCallbacks = new Set<FrameCallback>();
  private readonly resizeObserver: ResizeObserver;
  private intrinsics: CameraIntrinsics | null = null;
  private listener: SceneListener = {};
  private contextLost = false;
  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    video: HTMLVideoElement,
    quality: QualityProfile,
  ) {
    this.renderer = new WebGLRenderer({
      antialias: quality.antialias,
      alpha: true,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false,
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.xr.enabled = true;
    this.renderer.setClearColor(0x000000, 0);

    const canvas = this.renderer.domElement;
    canvas.className = 'ar-canvas';
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    container.appendChild(canvas);

    this.performance = new PerformanceManager(quality, (ratio) => {
      if (this.renderer.xr.isPresenting) return; // The XR layer decides its own resolution.
      this.renderer.setPixelRatio(ratio);
      this.syncSize();
    });
    this.renderer.setPixelRatio(this.performance.pixelRatio);

    this.anchor.matrixAutoUpdate = false;
    this.anchor.visible = false;
    this.scene.add(this.anchor);

    this.camera.matrixAutoUpdate = false;
    this.background = new CameraBackground(this.renderer, video);
    this.scene.add(this.background.mesh);

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

  setCameraIntrinsics(intrinsics: CameraIntrinsics) {
    this.intrinsics = intrinsics;
    this.updateProjection();
  }

  /** Immersive sessions bring their own camera image and projection. */
  setCameraFeedVisible(visible: boolean) {
    this.background.mesh.visible = visible;
  }

  get viewportSize() {
    return { width: this.container.clientWidth, height: this.container.clientHeight };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.timer.dispose();
    this.frameCallbacks.clear();
    this.background.dispose();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    canvas.remove();
  }

  private syncSize() {
    if (this.renderer.xr.isPresenting) return;
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.updateProjection();
  }

  /**
   * Builds the projection from tracker intrinsics, then scales it the way object-fit: cover scales
   * the camera image, so poster pixels and rendered pixels stay aligned at any viewport shape.
   */
  private updateProjection() {
    const k = this.intrinsics;
    if (!k) return;
    const { clientWidth: vw, clientHeight: vh } = this.container;
    if (!vw || !vh) return;

    const inputAspect = k.width / k.height;
    const viewAspect = vw / vh;
    const scaleX = viewAspect > inputAspect ? 1 : inputAspect / viewAspect;
    const scaleY = viewAspect > inputAspect ? viewAspect / inputAspect : 1;
    this.background.setUvScale(1 / scaleX, 1 / scaleY);

    const near = 0.02;
    const far = 60;
    const e = this.camera.projectionMatrix.elements;
    e.fill(0);
    e[0] = ((2 * k.focal) / k.width) * scaleX;
    e[5] = ((2 * k.focal) / k.height) * scaleY;
    e[10] = -(far + near) / (far - near);
    e[11] = -1;
    e[14] = (-2 * far * near) / (far - near);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
  }

  private readonly tick = (_time: number, xrFrame?: XRFrame) => {
    if (this.contextLost) return;
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    const time = this.timer.getElapsed();
    this.performance.frame(dt);
    for (const callback of this.frameCallbacks) callback(dt, time, xrFrame);
    this.renderer.render(this.scene, this.camera);
  };

  private readonly onContextLost = (event: Event) => {
    event.preventDefault(); // Without this the browser never restores the context.
    this.contextLost = true;
    this.listener.contextLost?.();
  };
}
