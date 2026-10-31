import { DoubleSide, Euler, Matrix4, Mesh, MeshBasicMaterial, Quaternion, RingGeometry, Vector3 } from 'three';
import type { Experience } from '../content/Experience';
import type { SceneManager } from '../core/SceneManager';
import { EngineError, errorKindFor } from '../services/errors';
import { CameraSource } from '../tracking/CameraSource';
import type { FrameResult } from '../tracking/protocol';
import type { TrackerClient } from '../tracking/TrackerClient';
import type { TrackingSink, TrackingStats } from '../types/ar';
import type { TrackingAdapter } from './TrackingAdapter';

export type PlacementState = 'searching' | 'ready' | 'placed' | 'poster-lock';

export interface VisionOptions {
  scene: SceneManager;
  /** `poster` locks onto printed posters. `room` places content on the floor by tapping. */
  mode: 'poster' | 'room';
  tracker: TrackerClient;
  onCameraGranted(): void;
  /** The tracker failed after it had started. */
  onFatal(detail: unknown): void;
  /** Null until content is ready to be placed. Read on each tap. */
  getPlaceable(): Experience | null;
  onPlacementState(state: PlacementState): void;
}

/** Room placement has no vision to tell it where the floor is, so assumes a phone held at this height. */
const CAMERA_HEIGHT = 1.6;
const MAX_PLACE_DISTANCE = 8;
/** The camera's vertical field of view in room placement, as a focal length over the long side of the image. */
const ROOM_FOCAL_FRACTION = 0.8;

/**
 * Our own tracker, on the rear camera. For posters, each camera frame goes to the worker, and comes
 * back with its pose. The two are drawn together, so content can't trail behind the camera image.
 * While nothing is locked the live camera is shown instead, as finding a poster is slower than following one.
 *
 * Room placement has only the phone's motion sensors, which measure turning but not moving. So content
 * stays in place as the phone turns, but not as the user walks.
 */
export class VisionAdapter implements TrackingAdapter {
  readonly kind = 'vision' as const;

  private sink: TrackingSink | null = null;
  private camera = new CameraSource();
  private running = false;
  private capturing = false;
  private last: FrameResult | null = null;
  private fps = 0;
  private lastResultAt = 0;

  private reticle: Mesh | null = null;
  private state: PlacementState = 'searching';
  private readonly floorPoint = new Vector3();
  private hasFloorPoint = false;
  private readonly placedPose = new Matrix4();
  private hasOrientation = false;
  private readonly pose = new Matrix4();

  constructor(private readonly options: VisionOptions) {
    if (options.mode === 'poster') this.state = 'poster-lock';
  }

  async start(sink: TrackingSink) {
    this.sink = sink;
    this.running = true;
    const { mode, scene, tracker } = this.options;
    try {
      await this.camera.start();
    } catch (err) {
      throw new EngineError(errorKindFor(err), err);
    }
    if (!this.running) return;
    this.options.onCameraGranted();
    scene.showLiveCamera(this.camera.video);
    this.options.onPlacementState(this.state);

    if (mode === 'poster') {
      tracker.reset();
      tracker.onFailed = (detail) => {
        if (this.running) this.options.onFatal(detail);
      };
      tracker.onResult = this.onResult;
      this.camera.onNewFrame(this.sendFrame);
    } else {
      scene.setRoomCamera(this.camera.video, ROOM_FOCAL_FRACTION, CAMERA_HEIGHT);
      this.createReticle();
      window.addEventListener('deviceorientation', this.onOrientation);
      scene.onFrame(this.onRoomFrame);
    }
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.sink = null;
    this.camera.stop();
    const { tracker } = this.options;
    tracker.onResult = null;
    tracker.onFailed = null;
    window.removeEventListener('deviceorientation', this.onOrientation);
    if (this.reticle) {
      this.reticle.removeFromParent();
      this.reticle.geometry.dispose();
      (this.reticle.material as MeshBasicMaterial).dispose();
      this.reticle = null;
    }
  }

  stats(): TrackingStats {
    const pose = this.last?.pose;
    return {
      engine: 'BAY81 tracker',
      trackFps: this.fps,
      confidence: pose || this.state === 'placed' ? 1 : 0,
      imageState: pose ? 'tracked' : 'none',
      mode: this.options.mode === 'room' ? 'room' : (this.last?.mode ?? 'search'),
      target: pose?.targetIndex ?? -1,
      points: pose?.points ?? 0,
      frameMs: this.last?.ms ?? 0,
    };
  }

  /** Places the content where the reticle is. Does nothing unless a floor point is in view. */
  tap() {
    if (this.options.mode !== 'room' || this.state === 'placed' || !this.hasFloorPoint) return;
    const content = this.options.getPlaceable();
    const spec = content?.placement;
    if (!content || !spec) return;

    // Turn to face the camera, so the tyre always stands upright and front on.
    const camera = this.options.scene.camera;
    const yaw = Math.atan2(camera.position.x - this.floorPoint.x, camera.position.z - this.floorPoint.z);
    const contact = new Vector3().fromArray(spec.contactPoint('floor')).multiplyScalar(spec.scale);
    const surface = new Matrix4().compose(this.floorPoint, new Quaternion().setFromAxisAngle(Y_AXIS, yaw), UNIT);
    const contentFromSurface = new Matrix4().compose(contact.negate(), new Quaternion(), scaleVector.setScalar(spec.scale));
    this.placedPose.multiplyMatrices(surface, contentFromSurface);

    content.usePlacement('floor');
    this.reticle!.visible = false;
    this.setState('placed');
  }

  private readonly sendFrame = () => {
    const { tracker } = this.options;
    const { video } = this.camera;
    if (this.capturing || !tracker.canTakeFrame || !video.videoWidth) return;
    this.capturing = true;
    void createImageBitmap(video)
      .then((frame) => {
        this.capturing = false;
        if (this.running) tracker.process(frame);
        else frame.close();
      })
      .catch(() => {
        this.capturing = false; // Skips this frame: the next one will work, or the camera has stopped.
      });
  };

  private readonly onResult = (result: FrameResult) => {
    if (!this.running) {
      result.frame.close();
      return;
    }
    const now = performance.now();
    if (this.lastResultAt) this.fps += (1000 / (now - this.lastResultAt) - this.fps) * 0.1;
    this.lastResultAt = now;
    this.last = result;

    const { scene } = this.options;
    if (result.pose) {
      scene.setProjection(result.width, result.height, result.focal);
      scene.showFrame(result.frame);
      this.pose.fromArray(result.pose.matrix);
      this.sink?.pose({ targetIndex: result.pose.targetIndex, matrix: this.pose, confidence: 1, time: now / 1000 });
    } else {
      result.frame.close();
      scene.showLiveCamera(this.camera.video);
      this.sink?.miss();
    }
  };

  private createReticle() {
    this.reticle = new Mesh(
      new RingGeometry(0.09, 0.115, 48).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ color: 0xffffff, side: DoubleSide, transparent: true, opacity: 0.9, toneMapped: false }),
    );
    this.reticle.visible = false;
    this.options.scene.scene.add(this.reticle);
  }

  private readonly onOrientation = (event: DeviceOrientationEvent) => {
    if (event.alpha === null || event.beta === null || event.gamma === null) return;
    this.hasOrientation = true;
    // The standard conversion of device orientation to a camera looking out of the back of the phone.
    const screen = (window.screen.orientation?.angle ?? 0) * DEGREES;
    euler.set(event.beta * DEGREES, event.alpha * DEGREES, -event.gamma * DEGREES, 'YXZ');
    this.options.scene.camera.quaternion.setFromEuler(euler).multiply(BACK_OF_PHONE).multiply(screenTurn.setFromAxisAngle(Z_AXIS, -screen));
  };

  private readonly onRoomFrame = () => {
    if (!this.running) return;
    if (this.state === 'placed') {
      this.sink?.pose({ targetIndex: 0, matrix: this.placedPose, confidence: 1, time: performance.now() / 1000 });
    } else {
      this.updateReticle();
    }
  };

  /** Where the middle of the view meets the assumed floor. */
  private updateReticle() {
    const { camera } = this.options.scene;
    if (!this.reticle) return;
    forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const distance = forward.y < 0 ? -camera.position.y / forward.y : Infinity;
    this.hasFloorPoint = this.hasOrientation && distance < MAX_PLACE_DISTANCE;
    this.reticle.visible = this.hasFloorPoint;
    if (this.hasFloorPoint) {
      this.floorPoint.copy(camera.position).addScaledVector(forward, distance);
      this.reticle.position.copy(this.floorPoint);
    }
    this.setState(this.hasFloorPoint ? 'ready' : 'searching');
  }

  private setState(state: PlacementState) {
    if (state === this.state) return;
    this.state = state;
    this.options.onPlacementState(state);
  }
}

const DEGREES = Math.PI / 180;
const UNIT = new Vector3(1, 1, 1);
const Y_AXIS = new Vector3(0, 1, 0);
const Z_AXIS = new Vector3(0, 0, 1);
const BACK_OF_PHONE = new Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);
const scaleVector = new Vector3();
const forward = new Vector3();
const euler = new Euler();
const screenTurn = new Quaternion();
