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
import { PerformanceManager, type QualityProfile } from './PerformanceManager';

export interface SceneListener {
  contextLost?(): void;
}

export type FrameCallback = (dt: number, time: number, xrFrame: XRFrame | undefined) => void;

/**
 * The renderer. Holds the single animation loop in the app, and the content anchor that the tracker
 * positions through a pose matrix. Chrome composites ARCore's camera image behind it, and three.js takes
 * the camera's pose and projection from each XR frame.
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

  constructor(
    private readonly container: HTMLElement,
    quality: QualityProfile,
  ) {
    this.renderer = new WebGLRenderer({
      antialias: false, // At phone pixel density it costs far more than it shows.
      alpha: true,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false,
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.xr.enabled = true;
    this.renderer.xr.setFramebufferScaleFactor(quality.xrFramebufferScale);
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

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.timer.dispose();
    this.frameCallbacks.clear();
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
