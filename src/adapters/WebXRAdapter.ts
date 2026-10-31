import {
  DoubleSide,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  RingGeometry,
  Vector3,
} from 'three';
import type { Experience, SurfaceKind } from '../content/Experience';
import type { SceneManager } from '../core/SceneManager';
import type { TrackingSink, TrackingStats } from '../types/ar';
import type { TrackingAdapter } from './TrackingAdapter';

export type PlacementState = 'searching' | 'ready' | 'placed' | 'poster-lock';

interface ImageTrackingResult {
  readonly imageSpace: XRSpace;
  readonly index: number;
  readonly trackingState: 'tracked' | 'emulated' | 'untracked';
  readonly measuredWidthInMeters: number;
}

interface XRFrameWithImages extends XRFrame {
  getImageTrackingResults?(): ImageTrackingResult[];
}

interface XRSessionWithImages extends XRSession {
  getTrackedImageScores?(): Promise<string[]>;
}

export interface WebXROptions {
  session: XRSession;
  scene: SceneManager;
  /** `poster` locks onto printed posters with ARCore image tracking. `room` places content by tapping. */
  mode: 'poster' | 'room';
  /** Null until content is ready to be placed. Read on each tap. */
  getPlaceable(): Experience | null;
  onPlacementState(state: PlacementState): void;
}

/** A hit pose's Y axis is the surface normal. Below this vertical component, the surface is a wall. */
const WALL_NORMAL_MAX = 0.35;

/**
 * Picks the poster to show from ARCore's results. A poster in view beats one that is only remembered,
 * and the current poster keeps its place until another is actually in view, so content can't flip
 * between posters that ARCore is merely remembering.
 */
export function chooseImage<T extends { index: number; trackingState: string }>(results: readonly T[], current: number) {
  const usable = results.filter((r) => r.trackingState !== 'untracked');
  const inView = usable.filter((r) => r.trackingState === 'tracked');
  return (
    inView.find((r) => r.index === current) ??
    inView[0] ??
    usable.find((r) => r.index === current) ??
    usable[0] ??
    null
  );
}

/**
 * ARCore through WebXR immersive-ar. In `poster` mode ARCore's image tracking locks printed posters,
 * which Chrome keeps behind chrome://flags/#webxr-incubations. In `room` mode, hit testing finds real
 * surfaces and anchors hold what was placed.
 *
 * ARCore keeps a found poster's place in the room while it is out of view, reported as `emulated`.
 * Those poses are used as they are: content stays fixed in the room when the camera turns away, and is
 * already in place when the poster comes back. Poses aren't smoothed, as that would only add lag.
 *
 * Every immersive session is requested by the caller, since it must happen inside a user gesture.
 */
export class WebXRAdapter implements TrackingAdapter {
  readonly kind = 'webxr' as const;

  private sink: TrackingSink | null = null;
  private viewerSpace: XRReferenceSpace | null = null;
  private localSpace: XRReferenceSpace | null = null;
  private hitSource: XRHitTestSource | null = null;
  /** Hit results are only valid inside their own frame, so the pose is kept instead of the result. */
  private readonly lastHitPose = new Matrix4();
  private hasHit = false;
  private anchor: XRAnchor | null = null;
  private fixedPose: Matrix4 | null = null;
  private surface: SurfaceKind = 'floor';
  private unsubscribe: (() => void) | null = null;
  private state: PlacementState = 'searching';
  private readonly imageTracking: boolean;
  private readonly reticle: Mesh;
  private readonly contentFromSurface = new Matrix4();
  private readonly pose = new Matrix4();
  private readonly surfacePose = new Matrix4();
  private fps = 0;
  private currentImage = -1;
  private imageState = 'none';
  private measuredWidth = 0;
  private imageScores: string[] = [];

  constructor(private readonly options: WebXROptions) {
    this.imageTracking = options.mode === 'poster';
    this.reticle = new Mesh(
      new RingGeometry(0.09, 0.115, 48).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ color: 0xffffff, side: DoubleSide, transparent: true, opacity: 0.9, toneMapped: false }),
    );
    this.reticle.matrixAutoUpdate = false;
    this.reticle.visible = false;
  }

  async start(sink: TrackingSink) {
    const { session, scene } = this.options;
    this.sink = sink;

    const xr = scene.renderer.xr;
    xr.setReferenceSpaceType('local');
    await xr.setSession(session);
    this.localSpace = xr.getReferenceSpace();
    this.viewerSpace = await session.requestReferenceSpace('viewer');

    if (this.imageTracking) {
      this.setState('poster-lock');
      void (session as XRSessionWithImages)
        .getTrackedImageScores?.()
        .then((scores) => {
          this.imageScores = scores;
          if (scores.includes('untrackable')) console.warn('[AR] ARCore rejected a poster as untrackable:', scores);
        })
        .catch(() => undefined);
    } else {
      if (!session.requestHitTestSource) throw new Error('This device does not support AR hit testing.');
      this.hitSource = (await session.requestHitTestSource({ space: this.viewerSpace })) ?? null;
      session.addEventListener('select', this.onSelect);
      scene.scene.add(this.reticle);
    }

    session.addEventListener('end', this.onSessionEnd);
    this.unsubscribe = scene.onFrame((dt, _time, frame) => {
      if (dt > 0) this.fps += (1 / dt - this.fps) * 0.05;
      if (frame) this.onXRFrame(frame);
    });
  }

  stop() {
    const { session } = this.options;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.sink = null;
    session.removeEventListener('select', this.onSelect);
    session.removeEventListener('end', this.onSessionEnd);
    this.hitSource?.cancel();
    this.hitSource = null;
    this.anchor?.delete();
    this.anchor = null;
    this.reticle.removeFromParent();
    this.reticle.geometry.dispose();
    (this.reticle.material as MeshBasicMaterial).dispose();
    session.end().catch(() => undefined); // Already ended is fine.
  }

  stats(): TrackingStats {
    return {
      engine: this.imageTracking ? 'WebXR image tracking (ARCore)' : 'WebXR hit test + anchors (ARCore)',
      trackFps: this.fps,
      confidence: this.imageState === 'tracked' || this.state === 'placed' ? 1 : this.imageState === 'emulated' ? 0.5 : 0,
      imageState: this.imageState,
      imageScores: this.imageScores,
      measuredWidth: this.measuredWidth,
    };
  }

  private onXRFrame(frame: XRFrame) {
    if (this.imageTracking) {
      this.reportImageTracking(frame as XRFrameWithImages);
    } else if (this.state === 'placed') {
      this.reportPlacedPose(frame);
    } else {
      this.updateReticle(frame);
    }
  }

  private reportImageTracking(frame: XRFrameWithImages) {
    const image = chooseImage(frame.getImageTrackingResults?.() ?? [], this.currentImage);
    const pose = image && frame.getPose(image.imageSpace, this.localSpace!);
    if (!image || !pose) {
      this.imageState = 'none';
      this.sink?.miss();
      return;
    }
    this.currentImage = image.index;
    this.imageState = image.trackingState;
    this.measuredWidth = image.measuredWidthInMeters;
    // ARCore's image frame has +Y out of the image and +Z towards its bottom edge. The content frame
    // has +Z out and +Y towards the top edge, a -90 degree turn about X.
    this.pose.fromArray(pose.transform.matrix);
    this.pose.multiply(IMAGE_TO_CONTENT).scale(scaleVector.setScalar(image.measuredWidthInMeters));
    this.sink?.pose({
      targetIndex: image.index,
      matrix: this.pose,
      confidence: image.trackingState === 'tracked' ? 1 : 0.5,
      time: performance.now() / 1000,
    });
  }

  private updateReticle(frame: XRFrame) {
    const results = this.hitSource ? frame.getHitTestResults(this.hitSource) : [];
    const pose = results[0]?.getPose(this.localSpace!);
    this.hasHit = !!pose;
    this.reticle.visible = this.hasHit;
    if (pose) {
      this.lastHitPose.fromArray(pose.transform.matrix);
      this.reticle.matrix.copy(this.lastHitPose);
    }
    this.setState(pose ? 'ready' : 'searching');
  }

  private reportPlacedPose(frame: XRFrame) {
    if (this.anchor) {
      // ARCore refines anchors as it learns the room, so the pose is re-read every frame.
      const pose = this.anchor.anchorSpace && frame.getPose(this.anchor.anchorSpace, this.localSpace!);
      if (!pose) {
        this.sink?.miss();
        return;
      }
      this.surfacePose.fromArray(pose.transform.matrix);
    } else if (this.fixedPose) {
      this.surfacePose.copy(this.fixedPose);
    } else {
      return;
    }
    this.pose.multiplyMatrices(this.surfacePose, this.contentFromSurface);
    this.sink?.pose({ targetIndex: 0, matrix: this.pose, confidence: 1, time: performance.now() / 1000 });
  }

  private readonly onSelect = (event: XRInputSourceEvent) => {
    if (this.state === 'placed' || !this.hasHit) return;
    const content = this.options.getPlaceable();
    const spec = content?.placement;
    if (!content || !spec) return;

    const hit = this.lastHitPose;
    const normal = new Vector3().setFromMatrixColumn(hit, 1);
    const position = new Vector3().setFromMatrixPosition(hit);
    this.surface = Math.abs(normal.y) < WALL_NORMAL_MAX ? 'wall' : 'floor';

    // Build a world-aligned frame so that the tyre stands up regardless of how the plane's axes lie.
    const viewer = event.frame.getViewerPose(this.localSpace!);
    const orientation = new Quaternion();
    if (this.surface === 'floor') {
      const camera = viewer?.transform.position;
      const yaw = camera ? Math.atan2(camera.x - position.x, camera.z - position.z) : 0;
      orientation.setFromAxisAngle(Y_AXIS, yaw);
    } else {
      // Out of the wall with +Y as close to up as the wall allows, so the tyre can't end up rolled.
      const right = new Vector3().crossVectors(Y_AXIS, normal).normalize();
      const up = new Vector3().crossVectors(normal, right);
      orientation.setFromRotationMatrix(new Matrix4().makeBasis(right, up, normal));
    }

    const contact = new Vector3().fromArray(spec.contactPoint(this.surface)).multiplyScalar(spec.scale);
    this.contentFromSurface.compose(contact.negate(), IDENTITY_Q, scaleVector.setScalar(spec.scale));

    // The surface frame is the alignment above at the hit point. Anchors want the same pose.
    this.surfacePose.compose(position, orientation, UNIT);
    const anchorPose = new XRRigidTransform(
      { x: position.x, y: position.y, z: position.z },
      { x: orientation.x, y: orientation.y, z: orientation.z, w: orientation.w },
    );
    this.fixedPose = this.surfacePose.clone();
    event.frame
      .createAnchor?.(anchorPose, this.localSpace!)
      ?.then((anchor) => {
        // Anchored is better, but the fixed pose above already works if anchors aren't available.
        if (this.state === 'placed') this.anchor = anchor;
        else anchor.delete();
      })
      .catch(() => undefined);

    content.usePlacement(this.surface);
    this.reticle.visible = false;
    this.setState('placed');
  };

  private readonly onSessionEnd = () => {
    this.sink?.ended();
  };

  private setState(state: PlacementState) {
    if (state === this.state) return;
    this.state = state;
    this.options.onPlacementState(state);
  }
}

const IMAGE_TO_CONTENT = new Matrix4().makeRotationX(-Math.PI / 2);
const IDENTITY_Q = new Quaternion();
const UNIT = new Vector3(1, 1, 1);
const Y_AXIS = new Vector3(0, 1, 0);
const scaleVector = new Vector3();
