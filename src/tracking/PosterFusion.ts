import { Matrix4, Quaternion, Vector3 } from 'three';

/** Sightings kept. At a few per second this covers several seconds, which also limits ARCore drift. */
const MAX_SIGHTINGS = 24;
/** A sighting further away than this, in metres or poster widths, disagrees with the current estimate. */
const MIN_DISAGREE_METERS = 0.05;
const DISAGREE_WIDTHS = 0.12;
const DISAGREE_RADIANS = 0.35;
/** This many disagreeing sightings in a row means the poster really moved. */
const MOVED_AFTER = 2;
/** How firmly the assumed width holds until the camera's movement shows otherwise. */
const WIDTH_PRIOR_WEIGHT = 0.01;
const MIN_WIDTH = 0.05;
const MAX_WIDTH = 5;
const ROTATION_GAIN = 0.2;

interface Sighting {
  camera: Vector3;
  /** Camera to poster centre in world axes, with the poster's width as the unit. */
  toPoster: Vector3;
}

const rotation = new Quaternion();
const cameraRotation = new Quaternion();
const cameraPosition = new Vector3();
const unused = new Vector3();
const position = new Vector3();
const meanCamera = new Vector3();
const meanRay = new Vector3();

/**
 * Turns separate sightings of one poster into a steady place in ARCore's world.
 *
 * One camera image can't tell a small poster up close from a large one far away: they look identical,
 * but content sized wrongly slides off the print as soon as the camera moves. ARCore knows how far the
 * camera really moved, so sightings from different places settle the true width unless it is given.
 *
 * Each sighting uses the camera pose of its own frame, so the time taken to recognise it doesn't matter.
 */
export class PosterFusion {
  private readonly sightings: Sighting[] = [];
  private readonly orientation = new Quaternion();
  private readonly center = new Vector3();
  private strikes = 0;
  width: number;

  constructor(
    private readonly assumedWidth: number,
    private readonly widthIsKnown: boolean,
  ) {
    this.width = assumedWidth;
  }

  add(cameraWorld: Matrix4, posterInCamera: Matrix4) {
    cameraWorld.decompose(cameraPosition, cameraRotation, unused);
    posterInCamera.decompose(position, rotation, unused);
    rotation.premultiply(cameraRotation);
    const toPoster = position.clone().applyQuaternion(cameraRotation);

    if (this.sightings.length) {
      const offset = cameraPosition.clone().addScaledVector(toPoster, this.width).distanceTo(this.center);
      const angle = this.orientation.angleTo(rotation);
      if (offset > Math.max(MIN_DISAGREE_METERS, DISAGREE_WIDTHS * this.width) || angle > DISAGREE_RADIANS) {
        this.strikes += 1;
        if (this.strikes < MOVED_AFTER) return;
        this.sightings.length = 0;
      }
    }
    this.strikes = 0;

    if (this.sightings.length) this.orientation.slerp(rotation, ROTATION_GAIN);
    else this.orientation.copy(rotation);
    this.sightings.push({ camera: cameraPosition.clone(), toPoster });
    if (this.sightings.length > MAX_SIGHTINGS) this.sightings.shift();
    this.solve();
  }

  /** Writes the content anchor's pose: poster centre, orientation, and scale of the real width. */
  compose(target: Matrix4) {
    return target.compose(this.center, this.orientation, unused.setScalar(this.width));
  }

  /** The width where all sightings best agree on one centre, in closed form. */
  private solve() {
    meanCamera.set(0, 0, 0);
    meanRay.set(0, 0, 0);
    for (const s of this.sightings) {
      meanCamera.add(s.camera);
      meanRay.add(s.toPoster);
    }
    meanCamera.divideScalar(this.sightings.length);
    meanRay.divideScalar(this.sightings.length);

    if (!this.widthIsKnown) {
      let numerator = WIDTH_PRIOR_WEIGHT * this.assumedWidth;
      let denominator = WIDTH_PRIOR_WEIGHT;
      for (const s of this.sightings) {
        const rx = s.toPoster.x - meanRay.x;
        const ry = s.toPoster.y - meanRay.y;
        const rz = s.toPoster.z - meanRay.z;
        numerator -= (s.camera.x - meanCamera.x) * rx + (s.camera.y - meanCamera.y) * ry + (s.camera.z - meanCamera.z) * rz;
        denominator += rx * rx + ry * ry + rz * rz;
      }
      this.width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, numerator / denominator));
    }
    this.center.copy(meanCamera).addScaledVector(meanRay, this.width);
  }
}
