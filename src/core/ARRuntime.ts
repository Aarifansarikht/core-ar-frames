import { Quaternion, Raycaster } from 'three';
import { WebXRAdapter, type PlacementState } from '../adapters/WebXRAdapter';
import { EXPERIENCES, type ExperienceConfig, type HotspotConfig, type RuntimeOptions } from '../config/experiences';
import type { Experience } from '../content/Experience';
import { TyreExperience } from '../content/TyreExperience';
import { VideoExperience } from '../content/VideoExperience';
import type { ContentVideo } from '../services/ContentVideo';
import type { ARErrorKind, PoseSample, TrackingStats } from '../types/ar';
import { LightingManager } from './LightingManager';
import { ModelManager } from './ModelManager';
import { detectTier, qualityFor } from './PerformanceManager';
import { SceneManager } from './SceneManager';
import { TrackingManager } from './TrackingManager';

export interface RuntimeEvents {
  progress(fraction: number, label: string): void;
  found(config: ExperienceConfig): void;
  contentReady(): void;
  lost(): void;
  recovered(): void;
  hotspot(hotspot: HotspotConfig | null): void;
  placementState(state: PlacementState): void;
  xrEnded(): void;
  /** A tap arrived while muted video was blocked. Returns true if it was used to restart the video. */
  resumeBlockedVideo(): boolean;
  /** Something failed that needs the user: the app moves to its error screen. */
  fatal(kind: ARErrorKind, detail: unknown): void;
  /** Debug hook: called for each pose when `?debug` is on. */
  pose?(sample: PoseSample, runtime: ARRuntime): void;
}

const rayRotation = new Quaternion();

/**
 * Everything that needs Three.js and a tracker, split out of ARManager so the welcome screen stays
 * small. One runtime exists per running session and is thrown away afterwards, which is how the XR
 * session, and with it the camera, and every GPU resource get released on a single code path.
 */
export class ARRuntime {
  scene: SceneManager | null = null;

  private session: XRSession | null = null;
  private lighting: LightingManager | null = null;
  private models: ModelManager | null = null;
  private readonly tracking: TrackingManager;
  private experience: Experience | null = null;
  private experienceConfig: ExperienceConfig | null = null;
  private entered = false;
  private loadToken = 0;
  private unsubscribeFrame: (() => void) | null = null;
  private readonly raycaster = new Raycaster();
  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly options: RuntimeOptions,
    private readonly video: ContentVideo,
    private readonly events: RuntimeEvents,
  ) {
    this.tracking = new TrackingManager({
      found: (index) => void this.onFound(index),
      pose: this.onPose,
      lost: this.onLost,
      recovered: this.onRecovered,
      ended: () => this.events.xrEnded(),
    });
  }

  /**
   * Locks posters with ARCore's image tracking. `session` must have been requested synchronously inside
   * the tap that asked for it, and with the same poster list that ARCore's indices refer to.
   */
  async startPosterTracking(session: XRSession) {
    this.session = session;
    this.createScene();
    const deepLink = this.options.deepLink;
    // Content comes first, so it is ready to show on the very first pose.
    if (deepLink) await this.prepareExperience(deepLink, (f) => this.events.progress(f, 'Loading content'));
    this.lighting!.enableXREstimation();
    await this.tracking.start(
      new WebXRAdapter({
        session,
        scene: this.scene!,
        mode: 'poster',
        getPlaceable: () => this.experience,
        onPlacementState: () => undefined,
      }),
    );
    session.addEventListener('select', this.onXRSelect);
    this.events.progress(1, 'Ready');
  }

  /** `session` must have been requested synchronously inside the tap that asked for it. */
  async startPlacement(session: XRSession, config: ExperienceConfig) {
    this.session = session;
    this.createScene();
    await this.prepareExperience(config, (f) => this.events.progress(f, 'Loading content'));
    this.experience!.root.visible = false;
    this.lighting!.enableXREstimation();

    await this.tracking.start(
      new WebXRAdapter({
        session,
        scene: this.scene!,
        mode: 'room',
        getPlaceable: () => this.experience,
        onPlacementState: (state) => this.events.placementState(state),
      }),
    );
    session.addEventListener('select', this.onXRSelect);
  }

  stats(): TrackingStats | null {
    return this.tracking.stats();
  }

  get renderFps() {
    return this.scene?.performance.fps ?? 0;
  }

  /** Ends the session, which turns the camera off, and releases the GPU. Safe to call more than once. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.loadToken += 1;
    this.tracking.stop();
    this.session?.removeEventListener('select', this.onXRSelect);
    this.session?.end().catch(() => undefined); // Already ended is fine.
    this.unsubscribeFrame?.();
    this.experience?.dispose();
    this.experience = null;
    this.lighting?.dispose();
    this.models?.dispose();
    this.scene?.dispose();
    this.scene = null;
  }

  private createScene() {
    let scene: SceneManager;
    try {
      scene = new SceneManager(this.container, qualityFor(detectTier()));
    } catch (err) {
      this.events.fatal('webgl-init', err);
      throw err;
    }
    this.scene = scene;
    this.lighting = new LightingManager(scene.renderer, scene.scene);
    this.models = new ModelManager(scene.renderer);
    scene.setListener({ contextLost: () => this.events.fatal('webgl-lost', 'context lost') });
    this.unsubscribeFrame = scene.onFrame((dt, time) => {
      this.tracking.tick();
      this.experience?.update(dt, time);
    });
  }

  private async prepareExperience(config: ExperienceConfig, onProgress?: (fraction: number) => void) {
    if (this.experienceConfig === config) return;
    this.experience?.dispose();
    this.experience = null;
    this.experienceConfig = config;
    this.entered = false;

    const token = ++this.loadToken;
    const experience: Experience =
      config.kind === 'model'
        ? new TyreExperience(config, this.models!, this.lighting!)
        : new VideoExperience(config, this.video);
    try {
      await experience.load(onProgress);
    } catch (err) {
      if (token === this.loadToken) this.events.fatal('asset-load', err);
      throw err;
    }
    if (token !== this.loadToken) {
      experience.dispose();
      return;
    }
    this.experience = experience;
    this.scene!.anchor.add(experience.root);
  }

  private async onFound(index: number) {
    const config = this.options.deepLink ?? EXPERIENCES[index];
    if (!config) return;
    this.events.found(config);
    this.events.hotspot(null);
    try {
      await this.prepareExperience(config, (f) => this.events.progress(f, 'Loading content'));
    } catch {
      return; // Reported through events.fatal.
    }
    if (this.disposed || this.experienceConfig !== config || !this.experience) return;
    this.scene!.anchor.visible = true;
    this.experience.enter();
    this.entered = true;
    this.events.contentReady();
  }

  private readonly onPose = (sample: PoseSample) => {
    this.scene?.setAnchorPose(sample.matrix);
    this.events.pose?.(sample, this);
  };

  private readonly onLost = () => {
    this.experience?.suspend();
    this.events.lost();
  };

  private readonly onRecovered = () => {
    this.experience?.resume();
    if (this.scene) this.scene.anchor.visible = true;
    this.events.recovered();
  };

  private readonly onXRSelect = (event: XRInputSourceEvent) => {
    if (this.events.resumeBlockedVideo()) return;
    const experience = this.experience;
    const refSpace = this.scene?.renderer.xr.getReferenceSpace();
    if (!experience || !refSpace || !this.entered) return;
    const pose = event.frame.getPose(event.inputSource.targetRaySpace, refSpace);
    if (!pose) return;
    const { position: o, orientation: q } = pose.transform;
    this.raycaster.ray.origin.set(o.x, o.y, o.z);
    this.raycaster.ray.direction.set(0, 0, -1).applyQuaternion(rayRotation.set(q.x, q.y, q.z, q.w));
    this.events.hotspot(experience.select(this.raycaster));
  };
}
