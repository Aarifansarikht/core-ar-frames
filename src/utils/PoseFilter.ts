import { Matrix4, Quaternion, Vector3 } from 'three';

const TWO_PI = Math.PI * 2;
const alphaFor = (cutoff: number, dt: number) => {
  const r = TWO_PI * cutoff * dt;
  return r / (r + 1);
};

/** One Euro filter: low lag when moving, strong smoothing when still. Time is in seconds. */
class OneEuro {
  private value = 0;
  private velocity = 0;
  private primed = false;

  constructor(
    private readonly minCutoff: number,
    private readonly beta: number,
    private readonly velocityCutoff = 1.5,
  ) {}

  reset() {
    this.primed = false;
  }

  filter(x: number, dt: number) {
    if (!this.primed) {
      this.primed = true;
      this.value = x;
      this.velocity = 0;
      return x;
    }
    const rawVelocity = (x - this.value) / dt;
    this.velocity += alphaFor(this.velocityCutoff, dt) * (rawVelocity - this.velocity);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.velocity);
    this.value += alphaFor(cutoff, dt) * (x - this.value);
    return this.value;
  }
}

export interface PoseFilterTuning {
  /** Cutoff in Hz for the image-plane position when the target is still. */
  positionCutoff: number;
  /** How quickly smoothing opens up with image-plane speed (tangent units per second). */
  positionBeta: number;
  depthCutoff: number;
  depthBeta: number;
  rotationCutoff: number;
  /** How quickly rotation smoothing opens up, per radian per second. */
  rotationBeta: number;
}

// Tuned against scripts/test-tracking.mjs. The camera image is frame-locked to the pose, so any lag here
// shows up directly as overlay error: the filter only needs to remove sub-pixel noise when still, and
// should get out of the way as soon as anything moves.
export const DEFAULT_POSE_TUNING: PoseFilterTuning = {
  positionCutoff: 6,
  positionBeta: 300,
  depthCutoff: 4,
  depthBeta: 40,
  rotationCutoff: 5,
  rotationBeta: 40,
};

/**
 * Smooths a rigid camera-space pose.
 *
 * Position is filtered as image-plane tangents (x/z, y/z) and log depth rather than raw XYZ. Tracker
 * noise is roughly constant in pixels, so this keeps the filter's behaviour the same whether the
 * poster is near or far, and stops depth noise (the largest component) from leaking sideways on screen.
 */
export class PoseFilter {
  private readonly u: OneEuro;
  private readonly v: OneEuro;
  private readonly depth: OneEuro;
  private readonly q = new Quaternion();
  private readonly rawP = new Vector3();
  private readonly rawQ = new Quaternion();
  private readonly unit = new Vector3(1, 1, 1);
  private rotationSpeed = 0;
  private primed = false;
  private lastTime = 0;

  constructor(private readonly tuning: PoseFilterTuning = DEFAULT_POSE_TUNING) {
    this.u = new OneEuro(tuning.positionCutoff, tuning.positionBeta);
    this.v = new OneEuro(tuning.positionCutoff, tuning.positionBeta);
    this.depth = new OneEuro(tuning.depthCutoff, tuning.depthBeta);
  }

  reset() {
    this.u.reset();
    this.v.reset();
    this.depth.reset();
    this.rotationSpeed = 0;
    this.primed = false;
  }

  /** Filters `pose` in place. `time` is the capture time of the camera frame, in seconds. */
  apply(pose: Matrix4, time: number) {
    const { rawP, rawQ, q, tuning } = this;
    pose.decompose(rawP, rawQ, new Vector3());

    const raw = -rawP.z;
    if (!(raw > 1e-4)) return pose; // Behind the camera: the gate upstream rejects these, leave it be.

    let dt = time - this.lastTime;
    if (!this.primed || dt <= 0 || dt > 0.5) {
      // First frame, or a gap long enough that the old state says nothing about this one.
      this.reset();
      dt = 1 / 30;
    }
    this.lastTime = time;

    const u = this.u.filter(rawP.x / raw, dt);
    const v = this.v.filter(rawP.y / raw, dt);
    const d = Math.exp(this.depth.filter(Math.log(raw), dt));

    if (!this.primed) {
      q.copy(rawQ);
      this.primed = true;
    } else {
      const angle = q.angleTo(rawQ);
      this.rotationSpeed += alphaFor(1.5, dt) * (angle / dt - this.rotationSpeed);
      const cutoff = tuning.rotationCutoff + tuning.rotationBeta * this.rotationSpeed;
      q.slerp(rawQ, alphaFor(cutoff, dt));
    }

    rawP.set(u * d, v * d, -d);
    return pose.compose(rawP, q, this.unit);
  }
}
