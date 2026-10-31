import './workerDom';
import { Controller, type InputTensor, type ModelViewTransform, type TrackedFeatures } from 'mind-ar/src/image-target/controller.js';
import { Detector } from 'mind-ar/src/image-target/detector/detector.js';
import * as tf from '@tensorflow/tfjs-core';
import '../vendor/tfjs-lite';
import type { LocatorRequest, LocatorResponse } from './locatorProtocol';

/** Below this many confirmed features a homography fit is too easily pulled off the target. */
const MIN_TRACKED_POINTS = 8;
const SOLVE_PASSES = 4;
const CONVERGED_CONFIDENCE = 0.85;
const OUTLIER_ROUNDS = 2;
/** A feature is an outlier beyond this multiple of the median residual, with a floor for sub-pixel fits. */
const OUTLIER_FACTOR = 2.5;
const OUTLIER_FLOOR_PX = 1.5;

interface Pipeline {
  key: string;
  controller: Controller;
  input: OffscreenCanvas;
  context: OffscreenCanvasRenderingContext2D;
}

let targets: ArrayBuffer | null = null;
let pipeline: Pipeline | null = null;

const post = (message: LocatorResponse) => self.postMessage(message);

/** Rebuilt only when the camera size or lens changes. Shaders compile here, on the first use. */
function pipelineFor(width: number, height: number, k: [number, number, number, number]) {
  const key = `${width}x${height}:${k.map((v) => v.toFixed(1)).join()}`;
  if (pipeline?.key === key) return pipeline;
  if (pipeline) disposePipeline(pipeline);

  const controller = new Controller({ inputWidth: width, inputHeight: height });
  controller.projectionTransform = [
    [k[0], 0, k[2]],
    [0, k[1], k[3]],
    [0, 0, 1],
  ];
  controller.addImageTargetsFromBuffer(targets!);
  // MindAR looks at one 256 px square per frame and takes 9 frames to cover the image. This looks at
  // all of it each time, so a poster anywhere in view is found on the first frame that shows it.
  const detector = new Detector(width, height);
  controller.cropDetector = { detectMoving: (frame: InputTensor) => detector.detect(frame) };

  const input = new OffscreenCanvas(width, height);
  const context = input.getContext('2d', { alpha: false, willReadFrequently: false });
  if (!context) throw new Error('Could not create the recogniser input canvas');
  pipeline = { key, controller, input, context };
  return pipeline;
}

function disposePipeline({ controller }: Pipeline) {
  for (const t of [...controller.tracker.featurePointsListT, ...controller.tracker.imagePixelsListT, ...controller.tracker.imagePropertiesListT]) {
    t.dispose();
  }
  controller.dispose();
}

/** The readback is bottom-up or top-down depending on the camera texture, so `flip` is a parameter. */
function toImage(pixels: ArrayBuffer, width: number, height: number, flip: boolean) {
  const source = new Uint8ClampedArray(pixels);
  if (!flip) return new ImageData(source, width, height);
  const flipped = new Uint8ClampedArray(source.length);
  const row = width * 4;
  for (let y = 0; y < height; y++) flipped.set(source.subarray((height - 1 - y) * row, (height - y) * row), y * row);
  return new ImageData(flipped, width, height);
}

function residualsOf(k: number[][], pose: ModelViewTransform, { worldCoords, screenCoords }: TrackedFeatures) {
  return worldCoords.map((w, i) => {
    const x = pose[0][0] * w.x + pose[0][1] * w.y + pose[0][3];
    const y = pose[1][0] * w.x + pose[1][1] * w.y + pose[1][3];
    const z = pose[2][0] * w.x + pose[2][1] * w.y + pose[2][3];
    return Math.hypot(k[0][0] * (x / z) + k[0][2] - screenCoords[i].x, k[1][1] * (y / z) + k[1][2] - screenCoords[i].y);
  });
}

/** Solves, then removes the features that disagree with the consensus and solves again. */
async function refine(controller: Controller, start: ModelViewTransform, features: TrackedFeatures) {
  let pose = await controller._workerTrackUpdate(start, features);
  let current = features;
  for (let round = 0; round < OUTLIER_ROUNDS && pose; round++) {
    const residuals = residualsOf(controller.projectionTransform, pose, current);
    const median = [...residuals].sort((a, b) => a - b)[residuals.length >> 1];
    const limit = Math.max(OUTLIER_FLOOR_PX, median * OUTLIER_FACTOR);
    const kept = {
      worldCoords: current.worldCoords.filter((_, i) => residuals[i] <= limit),
      screenCoords: current.screenCoords.filter((_, i) => residuals[i] <= limit),
    };
    if (kept.worldCoords.length === current.worldCoords.length || kept.worldCoords.length < MIN_TRACKED_POINTS) break;
    current = kept;
    pose = (await controller._workerTrackUpdate(pose, current)) ?? pose;
  }
  return pose;
}

/** Keeps the pass that confirmed the most features, so a pose can't stop at the first plausible answer. */
async function solve(controller: Controller, frame: InputTensor, start: ModelViewTransform, target: number) {
  const total = controller.tracker.trackingKeyframeList[target].points.length;
  let best: { modelView: ModelViewTransform; confidence: number } | null = null;
  let modelView = start;
  for (let pass = 0; pass < SOLVE_PASSES; pass++) {
    const features = controller.tracker.track(frame, modelView, target);
    if (features.worldCoords.length < MIN_TRACKED_POINTS) break;
    const refined = await refine(controller, modelView, features);
    if (!refined) break;
    const confidence = features.worldCoords.length / Math.max(total, 1);
    if (!best || confidence >= best.confidence) best = { modelView: refined, confidence };
    modelView = refined;
    if (confidence >= CONVERGED_CONFIDENCE) break;
  }
  return best;
}

/**
 * Converts MindAR's pose (in marker pixels, origin at the marker's corner) to the content frame in
 * camera space: poster width 1, origin at the poster's centre, +Y up, +Z out. Null if it can't be right.
 */
function composePose(controller: Controller, modelView: ModelViewTransform, target: number) {
  const [w, h] = controller.markerDimensions![target];
  const m = controller.getWorldMatrix(modelView, target);
  const x = (m[0] * w) / 2 + (m[4] * h) / 2 + m[12];
  const y = (m[1] * w) / 2 + (m[5] * h) / 2 + m[13];
  const z = (m[2] * w) / 2 + (m[6] * h) / 2 + m[14];
  if (!(z < 0) || !Number.isFinite(x + y + z)) return null;
  // The poster must face the camera: its +Z in camera space has to point back at the viewer.
  if (m[8] * x + m[9] * y + m[10] * z >= 0) return null;
  return [m[0], m[1], m[2], 0, m[4], m[5], m[6], 0, m[8], m[9], m[10], 0, x / w, y / w, z / w, 1];
}

async function locate(request: Extract<LocatorRequest, { type: 'frame' }>): Promise<LocatorResponse> {
  const started = performance.now();
  const { controller, input, context } = pipelineFor(request.width, request.height, request.k);
  context.putImageData(toImage(request.pixels, request.width, request.height, request.flip), 0, 0);
  const frame = controller.inputLoader.loadInput(input as unknown as HTMLCanvasElement);
  try {
    const { targetIndex, modelViewTransform } = await controller._detectAndMatch(frame, request.order);
    const solved = targetIndex >= 0 && modelViewTransform ? await solve(controller, frame, modelViewTransform, targetIndex) : null;
    const matrix = solved ? composePose(controller, solved.modelView, targetIndex) : null;
    return {
      type: 'result',
      id: request.id,
      targetIndex: matrix ? targetIndex : -1,
      matrix,
      confidence: solved?.confidence ?? 0,
      ms: performance.now() - started,
    };
  } finally {
    frame.dispose();
  }
}

self.onmessage = async ({ data }: MessageEvent<LocatorRequest>) => {
  try {
    if (data.type === 'init') {
      await tf.setBackend('webgl');
      await tf.ready();
      const response = await fetch(data.targetsUrl);
      if (!response.ok) throw new Error(`Target data missing: ${data.targetsUrl} (${response.status})`);
      targets = await response.arrayBuffer();
      post({ type: 'ready' });
    } else {
      post(await locate(data));
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
