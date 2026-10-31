import { Matrix4, Vector3 } from 'three';
import { Controller, type InputTensor, type ModelViewTransform, type TrackedFeatures } from 'mind-ar/src/image-target/controller.js';
import * as tf from '@tensorflow/tfjs-core';
import '../vendor/tfjs-lite';
import type { CameraManager } from '../core/CameraManager';
import type { CameraBackground } from '../core/CameraBackground';
import type { CameraIntrinsics, TrackingSink, TrackingStats } from '../types/ar';
import { PoseFilter } from '../utils/PoseFilter';
import type { TrackingAdapter } from './TrackingAdapter';

/** A long-side FOV of 64 degrees fits the main rear camera of most phones in 16:9 video mode. */
const DEFAULT_FOV_LONG = 64;
/** Below this many confirmed features a homography fit is too easily pulled off the target. */
const MIN_TRACKED_POINTS = 8;
/** Solver passes on the frame where a target is acquired, and per frame while the lock is weak. */
const ACQUIRE_SOLVES = 5;
const WEAK_SOLVES = 2;
/** Share of target features confirmed. A correct lock on a fully visible poster measures about 0.9. */
const CONVERGED_CONFIDENCE = 0.85;
const GOOD_CONFIDENCE = 0.6;
/** While the lock is weak, re-run detection this often, in frames. */
const RECHECK_INTERVAL = 8;
/** How much better a re-detected pose must be to replace the current one. */
const RECHECK_MARGIN = 0.12;
const OUTLIER_ROUNDS = 2;
/** A feature is an outlier beyond this multiple of the median residual, with a floor for sub-pixel fits. */
const OUTLIER_FACTOR = 2.5;
const OUTLIER_FLOOR_PX = 1.5;

export interface ImageTrackingOptions {
  camera: CameraManager;
  background: CameraBackground;
  targetsUrl: string;
  /** Tracker input is scaled so its short side is this many pixels. */
  inputShortSide: number;
  fovLong: number | null;
  rawPose: boolean;
  onIntrinsics(intrinsics: CameraIntrinsics): void;
  onProgress?(fraction: number): void;
}

interface Solution {
  modelView: ModelViewTransform;
  confidence: number;
}

interface Pipeline {
  controller: Controller;
  /** The camera frame scaled to tracker size. MindAR sizes its input from the source's width and height. */
  input: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  width: number;
  height: number;
  intrinsics: CameraIntrinsics;
}

/**
 * MindAR-based tracking for every browser with getUserMedia and WebGL. This is the only option on
 * iOS Safari, and on Android it is what locks onto posters because Chrome keeps WebXR image tracking
 * behind a flag.
 *
 * It drives MindAR's per-frame steps rather than Controller.processVideo() to get:
 *  - real camera intrinsics (processVideo's controller hardcodes a 45 degree FOV)
 *  - frame locking: the camera image on screen is the exact frame the pose was solved from, so
 *    registered overlays don't swim against the poster while the camera moves
 *  - a pose filter that works on rigid poses rather than on raw matrix elements
 *  - per-frame confidence for the tracking state machine
 *  - protection against the wrong-but-stable locks that MindAR's refiner can settle into
 */
export class ImageTrackingAdapter implements TrackingAdapter {
  readonly kind = 'image' as const;

  private sink: TrackingSink | null = null;
  private running = false;
  private loopDone: Promise<void> = Promise.resolve();
  private targets: ArrayBuffer | null = null;
  private readonly pipelines = new Map<string, Pipeline>();
  private pipeline: Pipeline | null = null;
  private readonly filter = new PoseFilter();
  private readonly pose = new Matrix4();

  private activeTarget = -1;
  private lastModelView: ModelViewTransform | null = null;
  private weakFrames = 0;

  private frameWatcher = 0;
  private fps = 0;
  private processMs = 0;
  private confidence = 0;
  private lastFrameAt = 0;

  constructor(private readonly options: ImageTrackingOptions) {}

  async start(sink: TrackingSink) {
    const { options } = this;
    this.sink = sink;

    await tf.setBackend('webgl');
    await tf.ready();
    options.onProgress?.(0.15);

    const response = await fetch(options.targetsUrl);
    if (!response.ok) throw new Error(`Target data missing: ${options.targetsUrl} (${response.status})`);
    this.targets = await response.arrayBuffer();
    options.onProgress?.(0.45);

    this.preparePipeline();
    options.onProgress?.(1);

    this.running = true;
    this.loopDone = this.loop();
  }

  stop() {
    this.running = false;
    if (this.frameWatcher) {
      this.options.camera.video.cancelVideoFrameCallback?.(this.frameWatcher);
      this.frameWatcher = 0;
    }
    const pipelines = [...this.pipelines.values()];
    this.pipelines.clear();
    this.pipeline = null;
    this.sink = null;
    // A frame in flight may still be using these. Release them once the loop has drained.
    void this.loopDone.then(() => pipelines.forEach(disposePipeline));
  }

  stats(): TrackingStats {
    return {
      engine: 'MindAR image tracking',
      trackFps: this.fps,
      trackMs: this.processMs,
      confidence: this.confidence,
      inputWidth: this.pipeline?.width ?? 0,
      inputHeight: this.pipeline?.height ?? 0,
      fovLong: this.options.fovLong ?? DEFAULT_FOV_LONG,
    };
  }

  /** Builds (or reuses, after a rotation) the tracker for the current camera frame size. */
  private preparePipeline() {
    const { camera } = this.options;
    const video = camera.video;
    const scale = this.options.inputShortSide / Math.min(camera.width, camera.height);
    const width = Math.round(camera.width * Math.min(scale, 1));
    const height = Math.round(camera.height * Math.min(scale, 1));
    const key = `${width}x${height}`;

    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      // Long side, so that focal length survives rotation: portrait and landscape share one lens.
      const fovLong = ((this.options.fovLong ?? DEFAULT_FOV_LONG) * Math.PI) / 180;
      const focal = Math.max(width, height) / 2 / Math.tan(fovLong / 2);

      const controller = new Controller({ inputWidth: width, inputHeight: height });
      controller.projectionTransform = [
        [focal, 0, width / 2],
        [0, focal, height / 2],
        [0, 0, 1],
      ];
      controller.addImageTargetsFromBuffer(this.targets!);

      const input = document.createElement('canvas');
      input.width = width;
      input.height = height;
      const context = input.getContext('2d', { alpha: false });
      if (!context) throw new Error('Could not create the tracker input canvas');

      // Kernels compile on first use, which is slow on phones. Do it now behind the preloader.
      context.drawImage(video, 0, 0, width, height);
      controller.dummyRun(input);

      pipeline = { controller, input, context, width, height, intrinsics: { focal, width, height } };
      this.pipelines.set(key, pipeline);
    }

    this.pipeline = pipeline;
    this.options.onIntrinsics(pipeline.intrinsics);
  }

  private async loop() {
    const { camera, background } = this.options;
    let lastTime = -1;

    while (this.running) {
      const captureTime = await this.nextCameraFrame();
      if (!this.running) break;
      if (captureTime === lastTime) continue;
      lastTime = captureTime;

      const video = camera.video;
      if (this.pipeline && !fitsFrameSize(this.pipeline, camera.width, camera.height, this.options.inputShortSide)) {
        // Rotated. The stream carries on, only the tracker input changes. Pose continuity is gone.
        this.preparePipeline();
        this.dropTarget();
        this.sink?.miss();
        continue;
      }
      if (!this.pipeline || video.readyState < video.HAVE_CURRENT_DATA) continue;

      const started = performance.now();
      // Read the frame into the tracker and into the back texture together, so the pose solved from
      // it is the pose shown over it.
      const { controller, input, context, width, height } = this.pipeline;
      context.drawImage(video, 0, 0, width, height);
      const frame = controller.inputLoader.loadInput(input);
      background.capture();
      try {
        await this.processFrame(this.pipeline, frame, captureTime);
      } finally {
        frame.dispose();
      }

      const now = performance.now();
      this.processMs = now - started;
      if (this.lastFrameAt) this.fps += (1000 / (now - this.lastFrameAt) - this.fps) * 0.08;
      this.lastFrameAt = now;
    }
  }

  private async processFrame(pipeline: Pipeline, frame: InputTensor, time: number) {
    const { controller } = pipeline;
    const { background } = this.options;

    if (this.activeTarget < 0) {
      // Searching: nothing is registered yet, so the fastest possible preview wins over locking.
      background.present();
      const indices = controller.markerDimensions!.map((_, i) => i);
      const { targetIndex, modelViewTransform } = await controller._detectAndMatch(frame, indices);
      if (!this.running) return;
      const solved =
        targetIndex >= 0 && modelViewTransform
          ? await this.solve(controller, frame, modelViewTransform, targetIndex, ACQUIRE_SOLVES)
          : null;
      if (!this.running) return;
      if (!solved) {
        this.confidence = 0;
        this.sink?.miss();
        return;
      }
      this.adopt(solved);
      this.activeTarget = targetIndex;
      this.weakFrames = 0;
      this.filter.reset();
    } else {
      const solves = this.confidence < GOOD_CONFIDENCE ? WEAK_SOLVES : 1;
      const solved = await this.solve(controller, frame, this.lastModelView!, this.activeTarget, solves);
      if (!this.running) return;
      if (!solved) {
        this.dropTarget();
        background.present();
        this.sink?.miss();
        return;
      }
      this.adopt(solved);
      await this.recheckWeakLock(controller, frame);
      if (!this.running) return;
    }

    if (!this.composePose(controller, this.lastModelView!)) {
      this.dropTarget();
      background.present();
      this.sink?.miss();
      return;
    }

    if (!this.options.rawPose) this.filter.apply(this.pose, time);
    background.present();
    this.sink?.pose({ targetIndex: this.activeTarget, matrix: this.pose, confidence: this.confidence, time });
  }

  private adopt(solved: Solution) {
    this.lastModelView = solved.modelView;
    this.confidence = solved.confidence;
  }

  /**
   * Runs track + refine repeatedly on one frame, each pass warping the target with the pose from the
   * last. A fresh lock gets several passes so that it converges rather than stopping at the first
   * plausible pose. Keeps the pass that confirmed the most features.
   */
  private async solve(controller: Controller, frame: InputTensor, start: ModelViewTransform, target: number, passes: number) {
    const total = controller.tracker.trackingKeyframeList[target].points.length;
    let best: Solution | null = null;
    let modelView = start;
    for (let pass = 0; pass < passes; pass++) {
      const features = controller.tracker.track(frame, modelView, target);
      if (features.worldCoords.length < MIN_TRACKED_POINTS) break;
      const refined = await this.refine(controller, modelView, features);
      if (!refined || !this.running) break;
      const confidence = features.worldCoords.length / Math.max(total, 1);
      if (!best || confidence >= best.confidence) best = { modelView: refined, confidence };
      modelView = refined;
      if (confidence >= CONVERGED_CONFIDENCE) break;
    }
    return best;
  }

  /**
   * MindAR's refiner runs plain least squares first and accepts it once mean squared error is under
   * 5 px, so a few false template matches can bend the fit without ever triggering its robust passes.
   * The next frame then searches from that bent pose, which makes the error self-sustaining (measured:
   * a steady 15 px at 83% confidence). So after each solve the features that disagree with the consensus
   * are removed and the pose is solved again.
   */
  private async refine(controller: Controller, start: ModelViewTransform, features: TrackedFeatures) {
    let pose = await controller._workerTrackUpdate(start, features);
    let current = features;
    for (let round = 0; round < OUTLIER_ROUNDS && pose && this.running; round++) {
      const kept = withoutOutliers(controller.projectionTransform, pose, current);
      if (kept.worldCoords.length === current.worldCoords.length || kept.worldCoords.length < MIN_TRACKED_POINTS) break;
      current = kept;
      pose = (await controller._workerTrackUpdate(pose, current)) ?? pose;
    }
    return pose;
  }

  /**
   * A wrong lock can also hold steady at low confidence (measured: 100 px off at 37% confidence, against
   * 90% when correct), and a tracker never leaves it by itself. So while confidence stays low, detection
   * re-runs in the background and takes over only if its answer is clearly better. Low confidence alone
   * isn't proof of a bad lock, as a poster that is partly out of frame looks the same.
   */
  private async recheckWeakLock(controller: Controller, frame: InputTensor) {
    if (this.confidence >= GOOD_CONFIDENCE) {
      this.weakFrames = 0;
      return;
    }
    this.weakFrames += 1;
    if (this.weakFrames % RECHECK_INTERVAL !== 0) return;

    const { targetIndex, modelViewTransform } = await controller._detectAndMatch(frame, [this.activeTarget]);
    if (targetIndex !== this.activeTarget || !modelViewTransform || !this.running) return;
    const solved = await this.solve(controller, frame, modelViewTransform, targetIndex, ACQUIRE_SOLVES);
    if (solved && solved.confidence > this.confidence + RECHECK_MARGIN) {
      this.adopt(solved);
      this.filter.reset(); // The old pose was wrong, so smoothing towards it would only add error.
    }
  }

  private dropTarget() {
    this.activeTarget = -1;
    this.lastModelView = null;
    this.confidence = 0;
  }

  /**
   * Converts MindAR's pose (in marker pixels, origin at the marker's corner) to the shared content
   * frame: poster width 1, origin at the poster's centre, +Y up, +Z out. Returns false for a pose
   * that can't be right, so a bad solve is treated as a miss and not drawn.
   */
  private composePose(controller: Controller, modelView: ModelViewTransform) {
    const index = this.activeTarget;
    const [w, h] = controller.markerDimensions![index];
    const m = controller.getWorldMatrix(modelView, index);

    const x = (m[0] * w) / 2 + (m[4] * h) / 2 + m[12];
    const y = (m[1] * w) / 2 + (m[5] * h) / 2 + m[13];
    const z = (m[2] * w) / 2 + (m[6] * h) / 2 + m[14];
    if (!(z < 0) || !Number.isFinite(x + y + z)) return false;

    // MindAR's rotation columns are unit length already, so only translation needs rescaling.
    this.pose.set(
      m[0], m[4], m[8], x / w,
      m[1], m[5], m[9], y / w,
      m[2], m[6], m[10], z / w,
      0, 0, 0, 1,
    );

    // The poster must face the camera: its +Z in camera space has to point back at the viewer.
    const normal = scratch.setFromMatrixColumn(this.pose, 2);
    return normal.x * x + normal.y * y + normal.z * z < 0;
  }

  /** Resolves with the capture time, in seconds, of the next new camera frame. */
  private nextCameraFrame() {
    const video = this.options.camera.video;
    return new Promise<number>((resolve) => {
      if (typeof video.requestVideoFrameCallback === 'function') {
        this.frameWatcher = video.requestVideoFrameCallback((now, metadata) => {
          this.frameWatcher = 0;
          resolve(metadata.captureTime !== undefined ? metadata.captureTime / 1000 : now / 1000);
        });
        // Frame callbacks stop while the page is hidden, and stop() may race with one. Don't hang.
        window.setTimeout(() => {
          if (!this.running) resolve(-1);
        }, 500);
      } else {
        window.requestAnimationFrame(() => resolve(video.currentTime));
      }
    });
  }
}

const scratch = new Vector3();

/** Pixel distance between each feature's match and where the pose projects it. */
function residualsOf(k: number[][], pose: ModelViewTransform, { worldCoords, screenCoords }: TrackedFeatures) {
  return worldCoords.map((w, i) => {
    const x = pose[0][0] * w.x + pose[0][1] * w.y + pose[0][3];
    const y = pose[1][0] * w.x + pose[1][1] * w.y + pose[1][3];
    const z = pose[2][0] * w.x + pose[2][1] * w.y + pose[2][3];
    return Math.hypot(k[0][0] * (x / z) + k[0][2] - screenCoords[i].x, k[1][1] * (y / z) + k[1][2] - screenCoords[i].y);
  });
}

function withoutOutliers(k: number[][], pose: ModelViewTransform, features: TrackedFeatures): TrackedFeatures {
  const residuals = residualsOf(k, pose, features);
  const median = [...residuals].sort((a, b) => a - b)[residuals.length >> 1];
  const limit = Math.max(OUTLIER_FLOOR_PX, median * OUTLIER_FACTOR);
  return {
    worldCoords: features.worldCoords.filter((_, i) => residuals[i] <= limit),
    screenCoords: features.screenCoords.filter((_, i) => residuals[i] <= limit),
  };
}

const fitsFrameSize = (p: Pipeline, width: number, height: number, shortSide: number) => {
  const scale = Math.min(shortSide / Math.min(width, height), 1);
  return p.width === Math.round(width * scale) && p.height === Math.round(height * scale);
};

function disposePipeline(p: Pipeline) {
  const { controller } = p;
  for (const t of [
    ...controller.tracker.featurePointsListT,
    ...controller.tracker.imagePixelsListT,
    ...controller.tracker.imagePropertiesListT,
  ]) {
    t.dispose();
  }
  controller.dispose();
}
