/// <reference lib="webworker" />
import { zoneAllows, type TrackingZone } from '../config/tracking';
import type { FromWorker, PosterPose, ToWorker } from './protocol';

/**
 * The poster tracker, in three parts:
 *  - Finding: ORB features in the frame are matched against each poster's compiled features. This is
 *    robust, but only roughly locates the poster, and is too slow for every frame.
 *  - Refining: the poster's own image is warped to where it should be, then compared with the frame at
 *    points across the whole poster. This is precise, removes drift, and shows that it really is the poster.
 *  - Following: those points are carried from frame to frame with optical flow, which is fast.
 * All of this runs here so that it can't delay drawing.
 */

// OpenCV.js ships no usable types for the parts of its bindings this needs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cv = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Mat = any;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

/** The long side of the image processed. More finds posters further away, but costs more on every frame. */
const PROCESS_LONG_SIDE = 720;
/** Every other search looks at more of the camera's detail, to find posters that are further away. */
const FAR_SEARCH_LONG_SIDE = 1280;
/** A phone's main camera, as a fraction of the image's long side. Only affects 3D depth, not alignment. */
const FOCAL_FRACTION = 0.8;
const FEATURES = 1200;
/** Lower than ORB's default of 20, so that dark posters and dim rooms still give features. */
const FAST_THRESHOLD = 10;
const RATIO = 0.8;
/** A true match rarely differs by more than this many of a descriptor's 256 bits. */
const MAX_DISTANCE = 72;
const MIN_MATCHES = 10;
const MIN_INLIERS = 12;
/** So many matches, spread across the poster, are enough to lock on when refining can't manage the view. */
const CONFIDENT_INLIERS = 25;
const RANSAC_PIXELS = 3;
const DESCRIPTOR_BYTES = 32;
/** Each byte of a descriptor indexes one table. A feature is compared only with those sharing a byte. */
const INDEX_BYTES = [0, 4, 8, 12, 16, 20, 24, 28];
const MIN_AREA_FRACTION = 0.005;

/**
 * How refining compares: at how many of a poster's features, drawn from all its compiled sizes, and how far
 * it can look. Locking on starts from a rough estimate and happens once. Once locked, the poster is nearly
 * in place, and refining has to be quick enough not to show as a stutter.
 */
const REFINE_THOROUGH = { points: 400, window: 21, levels: 3 };
const REFINE_QUICK = { points: 140, window: 13, levels: 1 };
/** Below this, the comparison says that this isn't the poster. */
const MIN_REFINED_POINTS = 16;
const REFINE_RANSAC_PIXELS = 2.5;
/** Refined points must cover this much of the visible poster, across and down, to fix its corners. */
const MIN_SPREAD = 0.25;
/** Points this close to the frame's edge can't be compared. */
const EDGE_MARGIN = 12;
const REFINE_EVERY_FRAMES = 20;
/** After a failed refine, look again sooner, as the poster may have gone. */
const REFINE_AGAIN_FRAMES = 3;
/** So many failed refines in a row mean the poster is no longer there, even if points still agree. */
const MAX_FAILED_REFINES = 3;

const MIN_FOLLOW_POINTS = 10;
const IMAGE_LEVELS = 4;

/**
 * The 1€ filter (Casiez et al., 2012): smooths hard when a value is nearly still, which removes jitter,
 * and hardly at all when it moves fast, which avoids lag.
 */
class OneEuroFilter {
  private value: number | null = null;
  private speed = 0;
  private time = 0;

  constructor(
    private readonly minCutoff: number,
    private readonly beta: number,
  ) {}

  next(value: number, time: number) {
    if (this.value === null) {
      this.value = value;
      this.speed = 0;
      this.time = time;
      return value;
    }
    const dt = Math.max(time - this.time, 1e-3);
    this.time = time;
    this.speed += OneEuroFilter.alpha(1, dt) * ((value - this.value) / dt - this.speed);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.speed);
    this.value += OneEuroFilter.alpha(cutoff, dt) * (value - this.value);
    return this.value;
  }

  reset() {
    this.value = null;
  }

  private static alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
}

interface Target {
  aspect: number;
  /** Where this poster's features begin in the combined descriptors. */
  offset: number;
  count: number;
  points: Float32Array;
  /** The features inside the areas chosen in the admin panel. The others are never used. */
  usable: number[];
  /** The poster's own image in grey, then at half that size, and so on. */
  images: Mat[];
}

let cv: Cv = null;
let targets: Target[] = [];
let orb: Mat = null;
/** Every poster's descriptors, end to end. */
let trainWords = new Uint32Array(0);
let buckets: number[][][] = [];
let seenAt = new Int32Array(0);
let stamp = 0;
let noMask: Mat = null;
let canvas: OffscreenCanvas | null = null;
let context: OffscreenCanvasRenderingContext2D | null = null;
let farCanvas: OffscreenCanvas | null = null;
let farContext: OffscreenCanvasRenderingContext2D | null = null;
let searchFar = false;

// What is being followed.
let current = -1;
let homography: number[] | null = null;
/** Image positions, x y pairs. */
let followImage: Float32Array = new Float32Array(0);
/** The same points in the content frame. */
let followPoster: Float32Array = new Float32Array(0);
let previous: Mat = null;
let framesSinceRefine = 0;
let refineAfter = REFINE_EVERY_FRAMES;
let failedRefines = 0;
const cornerFilters = Array.from({ length: 8 }, () => new OneEuroFilter(1.2, 0.015));
let rvec: Mat = null;
let tvec: Mat = null;

const post = (message: FromWorker, transfer: Transferable[] = []) => ctx.postMessage(message, transfer);

async function loadOpenCv(url: string) {
  if (import.meta.env.DEV) {
    // The dev server can only serve this file as a module, and modules can't use importScripts.
    (0, eval)(await (await fetch(url)).text());
  } else {
    ctx.importScripts(url);
  }
  const module = (ctx as unknown as { cv: Cv }).cv;
  const loaded = module instanceof Promise ? await module : module;
  if (!loaded.Mat) await new Promise<void>((resolve) => (loaded.onRuntimeInitialized = () => resolve()));
  return loaded;
}

/** See scripts/compile-targets.mjs for the format. */
async function loadTargets(urls: string[], zones: TrackingZone[][]) {
  const files = await Promise.all(
    urls.map(async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      return response.arrayBuffer();
    }),
  );
  const total = files.reduce((sum, file) => sum + new DataView(file).getUint32(0, true), 0);
  const trainBytes = new Uint8Array(total * DESCRIPTOR_BYTES);
  let offset = 0;
  const usableTrain: number[] = [];
  targets = files.map((file, targetIndex) => {
    const view = new DataView(file);
    const count = view.getUint32(0, true);
    const imageWidth = view.getUint32(8, true);
    const imageHeight = view.getUint32(12, true);
    const descriptorsAt = 16 + count * 8;
    trainBytes.set(new Uint8Array(file, descriptorsAt, count * DESCRIPTOR_BYTES), offset * DESCRIPTOR_BYTES);
    const image = new cv.Mat(imageHeight, imageWidth, cv.CV_8UC1);
    image.data.set(new Uint8Array(file, descriptorsAt + count * DESCRIPTOR_BYTES, imageWidth * imageHeight));
    const images: Mat[] = [image];
    for (let level = 1; level < IMAGE_LEVELS; level += 1) {
      const smaller = new cv.Mat();
      cv.pyrDown(images[level - 1], smaller);
      images.push(smaller);
    }
    const aspect = view.getFloat32(4, true);
    const points = new Float32Array(file, 16, count * 2);
    const usable: number[] = [];
    for (let i = 0; i < count; i += 1) {
      if (zoneAllows(zones[targetIndex] ?? [], points[i * 2] + 0.5, 0.5 - points[i * 2 + 1] / aspect)) {
        usable.push(i);
        usableTrain.push(offset + i);
      }
    }
    const target = { aspect, offset, count, points, usable, images };
    offset += count;
    return target;
  });
  trainWords = new Uint32Array(trainBytes.buffer);
  seenAt = new Int32Array(total);
  buckets = INDEX_BYTES.map((at) => {
    const table: number[][] = Array.from({ length: 256 }, () => []);
    for (const i of usableTrain) table[trainBytes[i * DESCRIPTOR_BYTES + at]].push(i);
    return table;
  });
}

const popcount = (n: number) => {
  let v = n - ((n >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

/**
 * The nearest two compiled features to each of the frame's. Checks only those sharing a byte with it,
 * typically a few hundred rather than thousands. It can miss a few true matches, which matters far less
 * than being fast enough to look again on the next frame.
 */
function matchFeatures(descriptors: Mat) {
  const rows = descriptors.rows as number;
  const bytes = new Uint8Array(rows * DESCRIPTOR_BYTES);
  bytes.set((descriptors.data as Uint8Array).subarray(0, rows * DESCRIPTOR_BYTES));
  const words = new Uint32Array(bytes.buffer);
  const matches: { query: number; train: number }[] = [];
  for (let q = 0; q < rows; q += 1) {
    stamp += 1;
    let best = 257;
    let second = 257;
    let bestIndex = -1;
    const w = q * 8;
    for (let table = 0; table < INDEX_BYTES.length; table += 1) {
      const bucket = buckets[table][bytes[q * DESCRIPTOR_BYTES + INDEX_BYTES[table]]];
      for (let c = 0; c < bucket.length; c += 1) {
        const candidate = bucket[c];
        if (seenAt[candidate] === stamp) continue;
        seenAt[candidate] = stamp;
        const t = candidate * 8;
        const distance =
          popcount(words[w] ^ trainWords[t]) +
          popcount(words[w + 1] ^ trainWords[t + 1]) +
          popcount(words[w + 2] ^ trainWords[t + 2]) +
          popcount(words[w + 3] ^ trainWords[t + 3]) +
          popcount(words[w + 4] ^ trainWords[t + 4]) +
          popcount(words[w + 5] ^ trainWords[t + 5]) +
          popcount(words[w + 6] ^ trainWords[t + 6]) +
          popcount(words[w + 7] ^ trainWords[t + 7]);
        if (distance < best) {
          second = best;
          best = distance;
          bestIndex = candidate;
        } else if (distance < second) {
          second = distance;
        }
      }
    }
    if (bestIndex >= 0 && best <= MAX_DISTANCE && best < RATIO * second) matches.push({ query: q, train: bestIndex });
  }
  return matches;
}

/** Solves a homography from x y pairs, returning it with which pairs agreed. */
function solveHomography(from: Float32Array, to: Float32Array, count: number, pixels = RANSAC_PIXELS) {
  const src = cv.matFromArray(count, 1, cv.CV_32FC2, Array.from(from.subarray(0, count * 2)));
  const dst = cv.matFromArray(count, 1, cv.CV_32FC2, Array.from(to.subarray(0, count * 2)));
  const mask = new cv.Mat();
  const solved = cv.findHomography(src, dst, cv.RANSAC, pixels, mask);
  const result = solved.empty() ? null : { h: Array.from(solved.data64F as Float64Array), inliers: Uint8Array.from(mask.data as Uint8Array) };
  src.delete();
  dst.delete();
  mask.delete();
  solved.delete();
  return result;
}

const project = (h: number[], x: number, y: number): [number, number] => {
  const w = h[6] * x + h[7] * y + h[8];
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
};

function cornersOf(h: number[], target: Target) {
  const hw = 0.5;
  const hh = target.aspect / 2;
  return [...project(h, -hw, hh), ...project(h, hw, hh), ...project(h, hw, -hh), ...project(h, -hw, -hh)];
}

/** Whether a solution looks like a real poster: a convex shape that isn't tiny or wildly distorted. */
function plausible(corners: number[], width: number, height: number) {
  let sign = 0;
  let area = 0;
  const sides: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const [ax, ay] = [corners[i * 2], corners[i * 2 + 1]];
    const [bx, by] = [corners[((i + 1) % 4) * 2], corners[((i + 1) % 4) * 2 + 1]];
    const [cx, cy] = [corners[((i + 2) % 4) * 2], corners[((i + 2) % 4) * 2 + 1]];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (cross === 0 || (sign !== 0 && Math.sign(cross) !== sign)) return false;
    sign = Math.sign(cross);
    area += ax * by - bx * ay;
    sides.push(Math.hypot(bx - ax, by - ay));
  }
  // A mirrored poster can't be a real view of it. In image axes, corners run clockwise, so this is positive.
  if (sign < 0) return false;
  if (Math.abs(area) / 2 < MIN_AREA_FRACTION * width * height) return false;
  return Math.max(sides[0], sides[2]) / Math.min(sides[0], sides[2]) < 5 && Math.max(sides[1], sides[3]) / Math.min(sides[1], sides[3]) < 5;
}

/** Whether points cover enough of the poster, across and down, to fix its corners. */
function wellSpread(points: Float32Array, count: number, target: Target) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < count; i += 1) {
    minX = Math.min(minX, points[i * 2]);
    maxX = Math.max(maxX, points[i * 2]);
    minY = Math.min(minY, points[i * 2 + 1]);
    maxY = Math.max(maxY, points[i * 2 + 1]);
  }
  return maxX - minX >= MIN_SPREAD && (maxY - minY) / target.aspect >= MIN_SPREAD;
}

/** Reads a frame's brightness into a new matrix. */
function grayOf(frame: ImageBitmap, drawing: OffscreenCanvasRenderingContext2D, width: number, height: number) {
  drawing.drawImage(frame, 0, 0, width, height);
  const { data } = drawing.getImageData(0, 0, width, height);
  const gray = new cv.Mat(height, width, cv.CV_8UC1);
  const pixels = gray.data as Uint8Array;
  for (let i = 0, p = 0; i < pixels.length; i += 1, p += 4) pixels[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
  return gray;
}

/** The whole frame at the far search's size, or null if the camera has no more detail to give. */
function farGrayOf(frame: ImageBitmap) {
  const scale = Math.min(FAR_SEARCH_LONG_SIDE, Math.max(frame.width, frame.height)) / Math.max(frame.width, frame.height);
  const width = Math.round(frame.width * scale);
  const height = Math.round(frame.height * scale);
  if (Math.max(width, height) <= PROCESS_LONG_SIDE) return null;
  if (!farCanvas || farCanvas.width !== width || farCanvas.height !== height) {
    farCanvas = new OffscreenCanvas(width, height);
    farContext = farCanvas.getContext('2d', { willReadFrequently: true });
  }
  return grayOf(frame, farContext!, width, height);
}

/**
 * Roughly locates a poster in the frame by its features. `only` limits it to one poster, and `toImage`
 * scales positions to the processed image.
 */
function find(gray: Mat, width: number, height: number, only = -1, toImage = 1) {
  const keypoints = new cv.KeyPointVector();
  const descriptors = new cv.Mat();
  try {
    orb.detectAndCompute(gray, noMask, keypoints, descriptors);
    if (descriptors.rows < MIN_MATCHES) return null;

    // Comparing against every poster at once means the ratio test also rejects look-alikes between them.
    const votes = targets.map((): { query: number; train: number }[] => []);
    for (const match of matchFeatures(descriptors)) {
      const owner = targets.findIndex((t) => match.train >= t.offset && match.train < t.offset + t.count);
      if (owner >= 0) votes[owner].push({ query: match.query, train: match.train - targets[owner].offset });
    }
    // Strongest first, as a poster with fewer matches may still be the real one if the first is rejected.
    const order = votes.map((_, index) => index).sort((a, b) => votes[b].length - votes[a].length);
    for (const target of order) {
      const list = votes[target];
      if (only >= 0 && target !== only) continue;
      if (list.length < MIN_MATCHES) break;
      const poster = new Float32Array(list.length * 2);
      const image = new Float32Array(list.length * 2);
      list.forEach((match, i) => {
        poster[i * 2] = targets[target].points[match.train * 2];
        poster[i * 2 + 1] = targets[target].points[match.train * 2 + 1];
        const { pt } = keypoints.get(match.query);
        image[i * 2] = pt.x * toImage;
        image[i * 2 + 1] = pt.y * toImage;
      });
      const solved = solveHomography(poster, image, list.length);
      if (!solved) continue;
      let count = 0;
      solved.inliers.forEach((inlier, i) => {
        if (!inlier) return;
        poster[count * 2] = poster[i * 2];
        poster[count * 2 + 1] = poster[i * 2 + 1];
        image[count * 2] = image[i * 2];
        image[count * 2 + 1] = image[i * 2 + 1];
        count += 1;
      });
      if (count >= MIN_INLIERS && plausible(cornersOf(solved.h, targets[target]), width, height)) {
        return { target, h: solved.h, count, poster: poster.slice(0, count * 2), image: image.slice(0, count * 2) };
      }
    }
    return null;
  } finally {
    keypoints.delete();
    descriptors.delete();
  }
}

/**
 * Corrects a pose against the poster's own image. Points on the poster are compared between the frame
 * and the poster's image warped to the pose. Null means the frame doesn't look like the poster there.
 */
function refine(gray: Mat, h: number[], index: number, effort = REFINE_QUICK) {
  const target = targets[index];
  const { cols: width, rows: height } = gray;

  // Which of the poster's points are in view, and where they should be.
  // Fine detail from a poster's largest size disappears when it is far away, so this takes from every size.
  const step = Math.max(1, target.usable.length / effort.points);
  const fromImage: number[] = [];
  const posterPoints: number[] = [];
  for (let n = 0; n < target.usable.length; n += step) {
    const i = target.usable[Math.floor(n)];
    const x = target.points[i * 2];
    const y = target.points[i * 2 + 1];
    const [u, v] = project(h, x, y);
    if (u >= EDGE_MARGIN && v >= EDGE_MARGIN && u < width - EDGE_MARGIN && v < height - EDGE_MARGIN) {
      fromImage.push(u, v);
      posterPoints.push(x, y);
    }
  }
  const count = fromImage.length / 2;
  if (count < MIN_REFINED_POINTS) return null;

  // The size of poster image nearest to how it appears. Shrinking one much further would add fine patterns
  // that the camera's image doesn't have, and the comparison would fail on them.
  const [leftX, leftY] = project(h, -0.5, 0);
  const [rightX, rightY] = project(h, 0.5, 0);
  const appears = Math.hypot(rightX - leftX, rightY - leftY);
  let source = target.images[0];
  for (const candidate of target.images) if (candidate.cols >= appears) source = candidate;
  const imageWidth = source.cols as number;
  const imageHeight = source.rows as number;

  // Poster image pixels to the content frame, then through the pose to the frame.
  const s = 1 / imageWidth;
  const toPoster = [s, 0, -0.5, 0, -s, (0.5 * imageHeight) / imageWidth, 0, 0, 1];
  const product = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      for (let k = 0; k < 3; k += 1) product[r * 3 + c] += h[r * 3 + k] * toPoster[k * 3 + c];
    }
  }
  const warp = cv.matFromArray(3, 3, cv.CV_64FC1, product);
  const warped = new cv.Mat();
  const size = new cv.Size(width, height);
  cv.warpPerspective(source, warped, warp, size, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());

  // Match overall brightness, as a dim room would otherwise make every point look different.
  const frameBytes = gray.data as Uint8Array;
  const warpedBytes = warped.data as Uint8Array;
  let frameSum = 1;
  let warpedSum = 1;
  for (let i = 0; i < count; i += 1) {
    const at = Math.round(fromImage[i * 2 + 1]) * width + Math.round(fromImage[i * 2]);
    frameSum += frameBytes[at];
    warpedSum += warpedBytes[at];
  }
  warped.convertTo(warped, -1, frameSum / warpedSum, 0);

  // A slight blur on both, so that differences in the finest detail don't decide the comparison.
  const blurSize = new cv.Size(3, 3);
  const frameSoft = new cv.Mat();
  cv.GaussianBlur(gray, frameSoft, blurSize, 0);
  cv.GaussianBlur(warped, warped, blurSize, 0);

  const from = cv.matFromArray(count, 1, cv.CV_32FC2, fromImage);
  const to = new cv.Mat();
  const status = new cv.Mat();
  const error = new cv.Mat();
  const criteria = new cv.TermCriteria(cv.TermCriteria_EPS | cv.TermCriteria_COUNT, 20, 0.03);
  cv.calcOpticalFlowPyrLK(warped, frameSoft, from, to, status, error, new cv.Size(effort.window, effort.window), effort.levels, criteria);

  const moved = to.data32F as Float32Array;
  const flags = status.data as Uint8Array;
  const poster = new Float32Array(count * 2);
  const image = new Float32Array(count * 2);
  let kept = 0;
  for (let i = 0; i < count; i += 1) {
    if (flags[i]) {
      poster[kept * 2] = posterPoints[i * 2];
      poster[kept * 2 + 1] = posterPoints[i * 2 + 1];
      image[kept * 2] = moved[i * 2];
      image[kept * 2 + 1] = moved[i * 2 + 1];
      kept += 1;
    }
  }
  for (const object of [warp, warped, frameSoft, from, to, status, error]) object.delete();
  if (kept < MIN_REFINED_POINTS) return null;

  const solved = solveHomography(poster, image, kept, REFINE_RANSAC_PIXELS);
  if (!solved) return null;
  let good = 0;
  solved.inliers.forEach((inlier, i) => {
    if (!inlier) return;
    poster[good * 2] = poster[i * 2];
    poster[good * 2 + 1] = poster[i * 2 + 1];
    image[good * 2] = image[i * 2];
    image[good * 2 + 1] = image[i * 2 + 1];
    good += 1;
  });
  if (good < MIN_REFINED_POINTS || !wellSpread(poster, good, target) || !plausible(cornersOf(solved.h, target), width, height)) return null;
  return { h: solved.h, poster: poster.slice(0, good * 2), image: image.slice(0, good * 2) };
}

function useRefined(refined: { h: number[]; poster: Float32Array; image: Float32Array }) {
  homography = refined.h;
  followImage = refined.image;
  followPoster = refined.poster;
  framesSinceRefine = 0;
  refineAfter = REFINE_EVERY_FRAMES;
  failedRefines = 0;
}

/** Moves the followed points into this frame. Returns false if too few of them made it. */
function follow(gray: Mat, width: number, height: number) {
  const count = followImage.length / 2;
  if (count < MIN_FOLLOW_POINTS || !previous || previous.cols !== width || previous.rows !== height) return false;
  const from = cv.matFromArray(count, 1, cv.CV_32FC2, Array.from(followImage));
  const to = new cv.Mat();
  const status = new cv.Mat();
  const error = new cv.Mat();
  const criteria = new cv.TermCriteria(cv.TermCriteria_EPS | cv.TermCriteria_COUNT, 20, 0.03);
  cv.calcOpticalFlowPyrLK(previous, gray, from, to, status, error, new cv.Size(21, 21), 3, criteria);

  const moved = to.data32F as Float32Array;
  const flags = status.data as Uint8Array;
  const poster = new Float32Array(count * 2);
  const image = new Float32Array(count * 2);
  let kept = 0;
  for (let i = 0; i < count; i += 1) {
    const x = moved[i * 2];
    const y = moved[i * 2 + 1];
    if (flags[i] && x >= 0 && y >= 0 && x < width && y < height) {
      poster[kept * 2] = followPoster[i * 2];
      poster[kept * 2 + 1] = followPoster[i * 2 + 1];
      image[kept * 2] = x;
      image[kept * 2 + 1] = y;
      kept += 1;
    }
  }
  for (const object of [from, to, status, error]) object.delete();
  if (kept < MIN_FOLLOW_POINTS) return false;

  const solved = solveHomography(poster, image, kept);
  if (!solved) return false;
  let good = 0;
  solved.inliers.forEach((inlier, i) => {
    if (!inlier) return;
    poster[good * 2] = poster[i * 2];
    poster[good * 2 + 1] = poster[i * 2 + 1];
    image[good * 2] = image[i * 2];
    image[good * 2 + 1] = image[i * 2 + 1];
    good += 1;
  });
  if (good < MIN_FOLLOW_POINTS || !plausible(cornersOf(solved.h, targets[current]), width, height)) return false;
  homography = solved.h;
  followImage = image.slice(0, good * 2);
  followPoster = poster.slice(0, good * 2);
  return true;
}

function resetFollowing() {
  current = -1;
  homography = null;
  followImage = new Float32Array(0);
  followPoster = new Float32Array(0);
  cornerFilters.forEach((filter) => filter.reset());
  rvec?.delete();
  tvec?.delete();
  rvec = null;
  tvec = null;
}

/** The 3D pose of the poster, from its smoothed corners. Starts from the last pose, which keeps it steady. */
function solvePose(corners: number[], target: Target, focal: number, width: number, height: number) {
  const hw = 0.5;
  const hh = target.aspect / 2;
  const object = cv.matFromArray(4, 1, cv.CV_32FC3, [-hw, hh, 0, hw, hh, 0, hw, -hh, 0, -hw, -hh, 0]);
  const image = cv.matFromArray(4, 1, cv.CV_32FC2, corners);
  const camera = cv.matFromArray(3, 3, cv.CV_64FC1, [focal, 0, width / 2, 0, focal, height / 2, 0, 0, 1]);
  const distortion = new cv.Mat();
  const guess = rvec !== null;
  if (!guess) {
    rvec = new cv.Mat();
    tvec = new cv.Mat();
  }
  cv.solvePnP(object, image, camera, distortion, rvec, tvec, guess, guess ? cv.SOLVEPNP_ITERATIVE : cv.SOLVEPNP_IPPE);
  const rotation = new cv.Mat();
  cv.Rodrigues(rvec, rotation);
  const r = rotation.data64F as Float64Array;
  const t = tvec.data64F as Float64Array;
  // OpenCV's camera has +Y down and looks along +Z. GL's has +Y up and looks along -Z.
  const matrix = [r[0], -r[3], -r[6], 0, r[1], -r[4], -r[7], 0, r[2], -r[5], -r[8], 0, t[0], -t[1], -t[2], 1];
  for (const item of [object, image, camera, distortion, rotation]) item.delete();
  return matrix;
}

function processFrame(frame: ImageBitmap) {
  const started = performance.now();
  const scale = PROCESS_LONG_SIDE / Math.max(frame.width, frame.height);
  const width = Math.round(frame.width * scale);
  const height = Math.round(frame.height * scale);
  if (!canvas || canvas.width !== width || canvas.height !== height) {
    canvas = new OffscreenCanvas(width, height);
    context = canvas.getContext('2d', { willReadFrequently: true });
    resetFollowing();
  }
  const gray = grayOf(frame, context!, width, height);

  let mode: 'search' | 'follow' | 'refine' = 'search';
  let tracked = false;
  if (current >= 0) {
    mode = 'follow';
    tracked = follow(gray, width, height);
    if (!tracked) resetFollowing();
  }
  if (tracked) {
    framesSinceRefine += 1;
    if (framesSinceRefine >= refineAfter) {
      mode = 'refine';
      framesSinceRefine = 0;
      const refined = refine(gray, homography!, current);
      if (refined) {
        useRefined(refined);
      } else {
        failedRefines += 1;
        refineAfter = REFINE_AGAIN_FRAMES;
        if (failedRefines >= MAX_FAILED_REFINES) {
          // Some views are beyond refining, so features have the last word on whether it's still there.
          if (find(gray, width, height, current)) {
            failedRefines = 0;
            refineAfter = REFINE_EVERY_FRAMES;
          } else {
            resetFollowing();
            tracked = false;
          }
        }
      }
    }
  } else {
    searchFar = !searchFar;
    const far = searchFar ? farGrayOf(frame) : null;
    const found = far ? find(far, width, height, -1, width / far.cols) : find(gray, width, height);
    far?.delete();
    // A first estimate can be too rough for the comparison, so a partial correction gets another go.
    let refined = found && refine(gray, found.h, found.target, REFINE_THOROUGH);
    if (found && refined) refined = refine(gray, refined.h, found.target, REFINE_THOROUGH) ?? refined;
    const confident = found && found.count >= CONFIDENT_INLIERS && wellSpread(found.poster, found.count, targets[found.target]);
    if (found && (refined || confident)) {
      resetFollowing();
      current = found.target;
      useRefined(refined ?? found);
      tracked = true;
    }
  }

  previous?.delete();
  previous = gray;

  let pose: PosterPose | null = null;
  const focal = FOCAL_FRACTION * PROCESS_LONG_SIDE;
  if (tracked && homography) {
    const target = targets[current];
    const time = started / 1000;
    const corners = cornersOf(homography, target).map((v, i) => cornerFilters[i].next(v, time));
    pose = {
      targetIndex: current,
      matrix: solvePose(corners, target, focal, width, height),
      corners,
      points: followImage.length / 2,
    };
  }
  post({ type: 'result', frame, pose, width, height, focal, ms: performance.now() - started, mode }, [frame]);
}

ctx.onmessage = async ({ data }: MessageEvent<ToWorker>) => {
  try {
    if (data.type === 'init') {
      cv = await loadOpenCv(data.opencvUrl);
      await loadTargets(data.targetUrls, data.zones);
      orb = new cv.ORB(FEATURES);
      orb.setFastThreshold(FAST_THRESHOLD);
      noMask = new cv.Mat();
      post({ type: 'ready' });
    } else if (data.type === 'reset') {
      resetFollowing();
      previous?.delete();
      previous = null;
    } else {
      processFrame(data.frame);
    }
  } catch (err) {
    // OpenCV throws plain numbers, which are pointers to the real exception.
    const detail = typeof err === 'number' && cv?.exceptionFromPtr ? cv.exceptionFromPtr(err).msg : String(err);
    post({ type: 'failed', detail });
  }
};
