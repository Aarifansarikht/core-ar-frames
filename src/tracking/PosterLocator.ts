import { Matrix4, type WebGLRenderer } from 'three';
import type { LocatorResponse } from './locatorProtocol';
import { CameraReadback } from './CameraReadback';
import { PosterFusion } from './PosterFusion';

/** How often to look while searching, and while a poster is locked and ARCore is holding it. */
const SEARCH_INTERVAL_MS = 60;
const LOCKED_INTERVAL_MS = 250;
/** Below this, a sighting is too weak to trust at all. A different poster has to clear the higher bar. */
const MIN_CONFIDENCE = 0.3;
const SWITCH_CONFIDENCE = 0.45;

/** WebXR's raw camera access, which three's type definitions don't include. */
export interface XRCamera {
  readonly width: number;
  readonly height: number;
}

export interface PosterLocatorOptions {
  renderer: WebGLRenderer;
  targetsUrl: string;
  /** Recogniser input is scaled so that its short side is this many pixels. */
  shortSide: number;
  targetCount: number;
  assumedWidth: number;
  widthIsKnown: boolean;
  onFatal(detail: unknown): void;
}

/**
 * Recognises posters in ARCore's camera image, and lets ARCore's world tracking hold them in place.
 * This needs no Chrome flag, unlike ARCore's own image tracking. All the recognition work is in a
 * worker, so that it can't delay rendering: between sightings the pose is simply a fixed place in
 * ARCore's world, and the camera's motion is handled by ARCore at full frame rate.
 */
export class PosterLocator {
  private readonly worker: Worker;
  private readonly readback: CameraReadback;
  private readonly fusions = new Map<number, PosterFusion>();
  private readonly captureWorld = new Matrix4();
  private readonly posterInCamera = new Matrix4();
  private ready = false;
  private busy = false;
  private nextId = 0;
  private lastCaptureAt = 0;
  private lastSightingAt = 0;
  private capturedK: [number, number, number, number] = [0, 0, 0, 0];
  private capturedWidth = 0;
  private capturedHeight = 0;
  /** Null until the first lock proves which way up ARCore's camera image is. */
  private flip: boolean | null = null;
  private tryFlip = true;
  private current = -1;
  private disposed = false;
  lastMs = 0;
  lastConfidence = 0;

  constructor(private readonly options: PosterLocatorOptions) {
    this.readback = new CameraReadback(options.renderer);
    this.worker = new Worker(new URL('./locator.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }: MessageEvent<LocatorResponse>) => this.onMessage(data);
    this.worker.onerror = (event) => options.onFatal(event.message);
    // Relative URLs would resolve against the worker's own script, not this page.
    this.worker.postMessage({ type: 'init', targetsUrl: new URL(options.targetsUrl, location.href).href });
  }

  get target() {
    return this.current;
  }

  get width() {
    return this.fusions.get(this.current)?.width ?? 0;
  }

  /** True while a sighting is recent, as opposed to ARCore holding a remembered place. */
  get seenRecently() {
    return performance.now() - this.lastSightingAt < 1000;
  }

  /** Runs once per XR frame. `view` must belong to `frame`. */
  update(view: XRView, cameraImage: (camera: XRCamera) => WebGLTexture | null) {
    this.send();
    const camera = (view as XRView & { camera?: XRCamera }).camera;
    const now = performance.now();
    const interval = this.current >= 0 ? LOCKED_INTERVAL_MS : SEARCH_INTERVAL_MS;
    if (!camera || !this.ready || this.busy || now - this.lastCaptureAt < interval) return;

    const source = cameraImage(camera);
    if (!source) return;
    const scale = Math.min(1, this.options.shortSide / Math.min(camera.width, camera.height));
    const width = Math.round(camera.width * scale);
    const height = Math.round(camera.height * scale);

    // The camera image lines up with the view, so the view's projection gives the lens. A fresh
    // session's projection already carries ARCore's calibration, so nothing is assumed about the phone.
    const p = view.projectionMatrix;
    this.capturedK = [(p[0] * width) / 2, (p[5] * height) / 2, ((1 - p[8]) * width) / 2, ((1 + p[9]) * height) / 2];
    this.capturedWidth = width;
    this.capturedHeight = height;
    this.captureWorld.fromArray(view.transform.matrix);
    this.lastCaptureAt = now;
    this.busy = true;
    this.readback.capture(source, width, height);
  }

  /** Writes the current poster's pose. False if no poster has been found yet. */
  compose(target: Matrix4) {
    const fusion = this.fusions.get(this.current);
    if (!fusion) return false;
    fusion.compose(target);
    return true;
  }

  dispose() {
    this.disposed = true;
    this.worker.terminate();
    this.readback.dispose();
  }

  private send() {
    if (!this.readback.pending) return;
    const pixels = this.readback.collect();
    if (!pixels) return;
    const flip = this.flip ?? this.tryFlip;
    this.tryFlip = !this.tryFlip;
    const count = this.options.targetCount;
    // The current poster goes first: it is by far the most likely to be in view.
    const order = [...Array(count).keys()].sort((a, b) => Number(b === this.current) - Number(a === this.current));
    this.worker.postMessage(
      {
        type: 'frame',
        id: this.nextId++,
        pixels: pixels.buffer,
        width: this.capturedWidth,
        height: this.capturedHeight,
        flip,
        k: this.capturedK,
        order,
      },
      [pixels.buffer],
    );
    this.lastFlip = flip;
  }

  private lastFlip = true;

  private onMessage(message: LocatorResponse) {
    if (this.disposed) return;
    if (message.type === 'ready') {
      this.ready = true;
    } else if (message.type === 'error') {
      this.options.onFatal(message.message);
    } else {
      this.busy = false;
      this.lastMs = message.ms;
      this.lastConfidence = message.confidence;
      if (message.matrix) this.onSighting(message.targetIndex, message.matrix, message.confidence);
    }
  }

  private onSighting(target: number, matrix: number[], confidence: number) {
    if (confidence < (target === this.current || this.current < 0 ? MIN_CONFIDENCE : SWITCH_CONFIDENCE)) return;
    this.flip = this.lastFlip;
    let fusion = this.fusions.get(target);
    if (!fusion) {
      fusion = new PosterFusion(this.options.assumedWidth, this.options.widthIsKnown);
      this.fusions.set(target, fusion);
    }
    fusion.add(this.captureWorld, this.posterInCamera.fromArray(matrix));
    this.current = target;
    this.lastSightingAt = performance.now();
  }
}
