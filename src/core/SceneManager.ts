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
import type { XR8Reality } from '../types/xr8';
import { PerformanceManager, type QualityProfile } from './PerformanceManager';

export interface SceneListener {
  contextLost?(): void;
}

export type FrameCallback = (dt: number, time: number) => void;

/** Sizes a canvas for the screen, in device pixels. */
export function sizeCanvas(canvas: HTMLCanvasElement, container: HTMLElement, pixelRatio: number) {
  canvas.width = Math.max(1, Math.round(container.clientWidth * pixelRatio));
  canvas.height = Math.max(1, Math.round(container.clientHeight * pixelRatio));
}

/**
 * The renderer. It draws into the engine's GL context, over the camera image that the engine has just
 * drawn, once per engine frame. Holds the content anchor that the tracker positions through a pose matrix.
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
  private readonly canvas: HTMLCanvasElement;
  private listener: SceneListener = {};
  private contextLost = false;
  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    gl: WebGL2RenderingContext,
    quality: QualityProfile,
  ) {
    this.canvas = gl.canvas as HTMLCanvasElement;
    this.renderer = new WebGLRenderer({ canvas: this.canvas, context: gl });
    this.renderer.autoClear = false; // The camera image is already in the frame.
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;

    this.canvas.addEventListener('webglcontextlost', this.onContextLost);

    this.performance = new PerformanceManager(quality, () => this.syncSize());

    this.anchor.matrixAutoUpdate = false;
    this.anchor.visible = false;
    this.scene.add(this.anchor);

    this.resizeObserver = new ResizeObserver(() => this.syncSize());
    this.resizeObserver.observe(container);
    this.syncSize();

    this.timer.connect(document);
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

  /** Follows the phone's pose and lens. The lens is what lines content up with the camera image. */
  setCamera({ position, rotation, intrinsics }: XR8Reality) {
    this.camera.position.set(position.x, position.y, position.z);
    this.camera.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
    this.camera.updateMatrixWorld();
    if (!Number.isFinite(intrinsics[0])) return; // Not known until the first camera frame has a size.
    this.camera.projectionMatrix.fromArray(intrinsics as number[]);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
  }

  /** Called by the engine, after it has drawn the camera image. */
  render() {
    if (this.contextLost || this.disposed) return;
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    const time = this.timer.getElapsed();
    this.performance.frame(dt);
    for (const callback of this.frameCallbacks) callback(dt, time);
    this.renderer.resetState(); // The engine has its own GL state, which three.js can't know about.
    this.renderer.clearDepth();
    this.renderer.render(this.scene, this.camera);
  }

  /** The engine owns the context, and the caller the canvas, so neither is torn down here. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver.disconnect();
    this.timer.dispose();
    this.frameCallbacks.clear();
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.renderer.dispose();
  }

  private syncSize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    sizeCanvas(this.canvas, this.container, this.performance.pixelRatio);
    this.renderer.setViewport(0, 0, this.canvas.width, this.canvas.height);
  }

  private readonly onContextLost = (event: Event) => {
    event.preventDefault(); // Without this the browser never restores the context.
    this.contextLost = true;
    this.listener.contextLost?.();
  };
}
