import { DoubleSide, Matrix4, Mesh, MeshBasicMaterial, Quaternion, RingGeometry, Vector3 } from 'three';
import type { Experience } from '../content/Experience';
import type { SceneManager } from '../core/SceneManager';
import { EngineError, errorKindFor } from '../services/errors';
import type { TrackingSink, TrackingStats } from '../types/ar';
import type { ImageTargetData, XR8Engine, XR8ImageDetail, XR8Reality } from '../types/xr8';
import type { TrackingAdapter } from './TrackingAdapter';

export type PlacementState = 'searching' | 'ready' | 'placed' | 'poster-lock';

export interface EightWallOptions {
  engine: XR8Engine;
  canvas: HTMLCanvasElement;
  /** `poster` locks onto printed posters. `room` places content on the floor by tapping. */
  mode: 'poster' | 'room';
  /** Order matters: poses report a poster by its index in this list. */
  targets: ImageTargetData[];
  /** Called once the engine has its GL context, which the scene draws with. */
  createScene(gl: WebGL2RenderingContext): SceneManager;
  onCameraGranted(): void;
  /** The engine failed after it had started. */
  onFatal(detail: unknown): void;
  /** Null until content is ready to be placed. Read on each tap. */
  getPlaceable(): Experience | null;
  onPlacementState(state: PlacementState): void;
}

/** Where the camera starts. The floor is y = 0 in this world, so its units are roughly metres. */
const CAMERA_ORIGIN = { x: 0, y: 1.6, z: 0 };
const CAMERA_FACING = { x: 0, y: 0, z: 0, w: 1 };
/** Beyond this the floor is too far away, or too near the horizon, to place on. */
const MAX_PLACE_DISTANCE = 8;

/**
 * The 8th Wall engine. It opens the camera, draws it, and runs its own frame loop, with the content
 * drawn on top in the same GL context. Image targets give poster poses directly, and world tracking
 * holds a poster's place while it is out of view, so content is already there on looking back.
 * Poses aren't smoothed, as that would only add lag.
 */
export class EightWallAdapter implements TrackingAdapter {
  readonly kind = '8thwall' as const;

  private sink: TrackingSink | null = null;
  private scene: SceneManager | null = null;
  private running = false;
  private status: XR8Reality['trackingStatus'] = 'LIMITED';
  private fps = 0;
  private lastFrameAt = 0;

  private readonly posterPoses = new Map<string, Matrix4>();
  private readonly visible = new Set<string>();
  private current: string | null = null;

  private reticle: Mesh | null = null;
  private state: PlacementState = 'searching';
  private readonly floorPoint = new Vector3();
  private hasFloorPoint = false;
  private readonly placedPose = new Matrix4();

  constructor(private readonly options: EightWallOptions) {
    if (options.mode === 'poster') this.state = 'poster-lock';
  }

  start(sink: TrackingSink) {
    this.sink = sink;
    const { engine, canvas, targets, mode } = this.options;
    return new Promise<void>((resolve, reject) => {
      let started = false;
      const fail = (detail: unknown) => {
        if (!this.running) return;
        if (started) {
          this.options.onFatal(detail);
        } else {
          reject(new EngineError(errorKindFor(detail), detail));
        }
      };
      const imagePose = ({ name, detail }: { name: string; detail: XR8ImageDetail }) => {
        if (name === 'reality.imagelost') this.visible.delete(detail.name);
        else this.onImage(detail);
      };

      engine.XrController.configure({ imageTargetData: mode === 'poster' ? targets : [], scale: 'responsive' });
      engine.addCameraPipelineModules([
        engine.GlTextureRenderer.pipelineModule(),
        engine.XrController.pipelineModule(),
        {
          name: 'bay81',
          onStart: ({ GLctx }: { GLctx: WebGL2RenderingContext }) => {
            try {
              this.scene = this.options.createScene(GLctx);
              if (mode === 'room') this.createReticle();
              this.options.onPlacementState(this.state);
              engine.XrController.updateCameraProjectionMatrix({ origin: CAMERA_ORIGIN, facing: CAMERA_FACING });
            } catch (err) {
              reject(err);
              return;
            }
            started = true;
            resolve();
          },
          onCameraStatusChange: ({ status, reason }: { status: string; reason?: string }) => {
            if (status === 'hasStream') this.options.onCameraGranted();
            else if (status === 'failed') fail({ type: 'camera', reason });
          },
          onException: fail,
          onUpdate: ({ processCpuResult }: { processCpuResult: { reality?: XR8Reality } }) => {
            if (processCpuResult.reality) this.onFrame(processCpuResult.reality);
          },
          onRender: () => this.scene?.render(),
          listeners: [
            { event: 'reality.trackingstatus', process: ({ detail }: { detail: { status: XR8Reality['trackingStatus'] } }) => (this.status = detail.status) },
            { event: 'reality.imagefound', process: imagePose },
            { event: 'reality.imageupdated', process: imagePose },
            { event: 'reality.imagelost', process: imagePose },
          ],
        },
      ]);
      this.running = true;
      engine.run({ canvas });
    });
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.sink = null;
    const { engine } = this.options;
    engine.stop(); // This also turns the camera off.
    engine.clearCameraPipelineModules();
    if (this.reticle) {
      this.reticle.removeFromParent();
      this.reticle.geometry.dispose();
      (this.reticle.material as MeshBasicMaterial).dispose();
      this.reticle = null;
    }
  }

  stats(): TrackingStats {
    const inView = this.current !== null && this.visible.has(this.current);
    return {
      engine: `8th Wall ${this.options.engine.version()}`,
      trackFps: this.fps,
      confidence: inView || this.state === 'placed' ? 1 : this.current ? 0.5 : 0,
      imageState: this.current ? (inView ? 'tracked' : 'held') : 'none',
      worldState: this.status,
      target: this.current ?? '-',
    };
  }

  /** Places the content where the reticle is. Does nothing unless a floor point is in view. */
  tap() {
    if (this.options.mode !== 'room' || this.state === 'placed' || !this.hasFloorPoint) return;
    const content = this.options.getPlaceable();
    const spec = content?.placement;
    const camera = this.scene?.camera;
    if (!content || !spec || !camera) return;

    // Turn to face the camera, so the tyre always stands upright and front on.
    const yaw = Math.atan2(camera.position.x - this.floorPoint.x, camera.position.z - this.floorPoint.z);
    const contact = new Vector3().fromArray(spec.contactPoint('floor')).multiplyScalar(spec.scale);
    const surface = new Matrix4().compose(this.floorPoint, new Quaternion().setFromAxisAngle(Y_AXIS, yaw), UNIT);
    const contentFromSurface = new Matrix4().compose(contact.negate(), new Quaternion(), scaleVector.setScalar(spec.scale));
    this.placedPose.multiplyMatrices(surface, contentFromSurface);

    content.usePlacement('floor');
    this.reticle!.visible = false;
    this.setState('placed');
  }

  private onFrame(reality: XR8Reality) {
    const now = performance.now();
    if (this.lastFrameAt) this.fps += (1000 / (now - this.lastFrameAt) - this.fps) * 0.05;
    this.lastFrameAt = now;
    this.status = reality.trackingStatus ?? this.status;
    this.scene?.setCamera(reality);
    if (this.options.mode === 'poster') this.reportPoster();
    else if (this.state === 'placed') this.reportPlaced();
    else this.updateReticle();
  }

  private onImage(detail: XR8ImageDetail) {
    let pose = this.posterPoses.get(detail.name);
    if (!pose) {
      pose = new Matrix4();
      this.posterPoses.set(detail.name, pose);
    }
    const target = this.options.targets.find((t) => t.name === detail.name);
    if (!target) return;
    // The engine's frame is the content frame, turned upright for rotated targets, and centred on the
    // crop, which is also the poster's centre. Only the size needs changing: content is one poster wide.
    const { width, height, isRotated, originalWidth, originalHeight } = target.properties;
    const posterWidth = (detail.scale * (isRotated ? originalHeight : originalWidth)) / Math.max(width, height);
    pose.compose(
      position.set(detail.position.x, detail.position.y, detail.position.z),
      rotation.set(detail.rotation.x, detail.rotation.y, detail.rotation.z, detail.rotation.w),
      scaleVector.setScalar(posterWidth),
    );
    this.visible.add(detail.name);
  }

  /** The current poster keeps its place until another is actually in view, so content can't flip between them. */
  private reportPoster() {
    if (!this.current || !this.visible.has(this.current)) {
      const [next] = this.visible;
      if (next) this.current = next;
    }
    const pose = this.current ? this.posterPoses.get(this.current) : null;
    // A held poster's place means nothing once the engine has lost track of the room.
    if (!pose || (this.status === 'LIMITED' && !this.visible.has(this.current!))) {
      this.sink?.miss();
      return;
    }
    this.sink?.pose({
      targetIndex: this.options.targets.findIndex((t) => t.name === this.current),
      matrix: pose,
      confidence: this.visible.has(this.current!) ? 1 : 0.5,
      time: performance.now() / 1000,
    });
  }

  private createReticle() {
    this.reticle = new Mesh(
      new RingGeometry(0.09, 0.115, 48).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ color: 0xffffff, side: DoubleSide, transparent: true, opacity: 0.9, toneMapped: false }),
    );
    this.reticle.visible = false;
    this.scene!.scene.add(this.reticle);
  }

  /** Where the middle of the view meets the floor. The world's floor is y = 0, whatever the room looks like. */
  private updateReticle() {
    const camera = this.scene?.camera;
    if (!camera || !this.reticle) return;
    forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const distance = forward.y < 0 ? -camera.position.y / forward.y : Infinity;
    this.hasFloorPoint = this.status === 'NORMAL' && distance < MAX_PLACE_DISTANCE;
    this.reticle.visible = this.hasFloorPoint;
    if (this.hasFloorPoint) {
      this.floorPoint.copy(camera.position).addScaledVector(forward, distance);
      this.reticle.position.copy(this.floorPoint);
    }
    this.setState(this.hasFloorPoint ? 'ready' : 'searching');
  }

  private reportPlaced() {
    if (this.status === 'LIMITED') {
      this.sink?.miss();
      return;
    }
    this.sink?.pose({ targetIndex: 0, matrix: this.placedPose, confidence: 1, time: performance.now() / 1000 });
  }

  private setState(state: PlacementState) {
    if (state === this.state) return;
    this.state = state;
    this.options.onPlacementState(state);
  }
}

const UNIT = new Vector3(1, 1, 1);
const Y_AXIS = new Vector3(0, 1, 0);
const scaleVector = new Vector3();
const position = new Vector3();
const forward = new Vector3();
const rotation = new Quaternion();
