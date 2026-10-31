import { Raycaster, Vector2 } from 'three';
import { EightWallAdapter, type PlacementState } from '../adapters/EightWallAdapter';
import { EXPERIENCES, type ExperienceConfig, type HotspotConfig, type RuntimeOptions } from '../config/experiences';
import type { Experience } from '../content/Experience';
import { TyreExperience } from '../content/TyreExperience';
import { VideoExperience } from '../content/VideoExperience';
import { ContentVideo } from '../services/ContentVideo';
import { EngineError } from '../services/errors';
import type { ARErrorKind, PoseSample, TrackingStats } from '../types/ar';
import type { ImageTargetData, XR8Engine } from '../types/xr8';
import { LightingManager } from './LightingManager';
import { ModelManager } from './ModelManager';
import { detectTier, qualityFor } from './PerformanceManager';
import { SceneManager, sizeCanvas } from './SceneManager';
import { TrackingManager } from './TrackingManager';

export interface RuntimeEvents {
  /** The user allowed the camera, and the engine is starting. */
  cameraGranted(): void;
  progress(fraction: number, label: string): void;
  found(config: ExperienceConfig): void;
  contentReady(): void;
  lost(): void;
  recovered(): void;
  hotspot(hotspot: HotspotConfig | null): void;
  placementState(state: PlacementState): void;
  ended(): void;
  /** The browser refused to start a muted video until the next tap. */
  videoBlocked(): void;
  /** Returns true if video was blocked, in which case the next tap is for restarting it. */
  takeVideoBlocked(): boolean;
  /** Something failed that needs the user: the app moves to its error screen. */
  fatal(kind: ARErrorKind, detail: unknown): void;
  /** Debug hook: called for each pose when `?debug` is on. */
  pose?(sample: PoseSample, runtime: ARRuntime): void;
}

/**
 * Everything that needs Three.js and the engine, split out of ARManager so the welcome screen stays
 * small. One runtime exists per running session and is thrown away afterwards, which is how the camera
 * and every GPU resource get released on a single code path.
 */
export class ARRuntime {
  scene: SceneManager | null = null;

  private adapter: EightWallAdapter | null = null;
  private lighting: LightingManager | null = null;
  private models: ModelManager | null = null;
  private readonly canvas = document.createElement('canvas');
  private readonly tracking: TrackingManager;
  private experience: Experience | null = null;
  private readonly experiences = new Map<string, Promise<Experience>>();
  private readonly videos: ContentVideo[] = [];
  private entered = false;
  private loadToken = 0;
  private unsubscribeFrame: (() => void) | null = null;
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly engine: XR8Engine,
    private readonly options: RuntimeOptions,
    private readonly events: RuntimeEvents,
  ) {
    this.tracking = new TrackingManager({
      found: (index) => void this.onFound(index),
      pose: this.onPose,
      lost: this.onLost,
      recovered: this.onRecovered,
      ended: () => this.events.ended(),
    });
  }

  /** Locks posters. Poses refer to posters by their place in `targets`. */
  async startPosterTracking(targets: ImageTargetData[]) {
    await this.startEngine('poster', targets);
    const deepLink = this.options.deepLink;
    window.addEventListener('click', this.onTap);
    if (deepLink) {
      try {
        // Otherwise the first poster found has to load before it shows.
        await this.prepareExperience(deepLink, (f) => this.events.progress(f, 'Loading content'));
      } catch (err) {
        this.events.fatal('asset-load', err);
        throw err;
      }
    }
    this.events.progress(1, 'Ready');
    void this.warmOtherPosters();
  }

  async startPlacement(config: ExperienceConfig) {
    await this.startEngine('room', []);
    try {
      this.experience = await this.prepareExperience(config, (f) => this.events.progress(f, 'Loading content'));
    } catch (err) {
      this.events.fatal('asset-load', err);
      throw err;
    }
    this.experience.root.visible = false;
    window.addEventListener('click', this.onTap);
  }

  stats(): TrackingStats | null {
    return this.tracking.stats();
  }

  get renderFps() {
    return this.scene?.performance.fps ?? 0;
  }

  /** Stops the engine, which turns the camera off, and releases the GPU. Safe to call more than once. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.loadToken += 1;
    window.removeEventListener('click', this.onTap);
    this.tracking.stop();
    this.unsubscribeFrame?.();
    this.experience = null;
    for (const loading of this.experiences.values()) {
      void loading.then((experience) => experience.dispose()).catch(() => undefined);
    }
    this.experiences.clear();
    this.lighting?.dispose();
    this.models?.dispose();
    this.scene?.dispose();
    this.scene = null;
    this.canvas.remove();
  }

  /** Resolves when the camera is running and the scene exists. */
  private startEngine(mode: 'poster' | 'room', targets: ImageTargetData[]) {
    const quality = qualityFor(detectTier());
    this.canvas.className = 'ar-canvas';
    this.container.appendChild(this.canvas);
    sizeCanvas(this.canvas, this.container, Math.min(window.devicePixelRatio || 1, quality.maxPixelRatio));

    this.adapter = new EightWallAdapter({
      engine: this.engine,
      canvas: this.canvas,
      mode,
      targets,
      createScene: (gl) => this.createScene(gl),
      onCameraGranted: () => this.events.cameraGranted(),
      onFatal: (detail) => this.events.fatal('tracking-init', detail),
      getPlaceable: () => this.experience,
      onPlacementState: (state) => this.events.placementState(state),
    });
    return this.tracking.start(this.adapter);
  }

  private createScene(gl: WebGL2RenderingContext) {
    let scene: SceneManager;
    try {
      scene = new SceneManager(this.container, gl, qualityFor(detectTier()));
    } catch (err) {
      throw new EngineError('webgl-init', err);
    }
    this.scene = scene;
    this.lighting = new LightingManager(scene.renderer, scene.scene);
    this.models = new ModelManager(scene.renderer);
    scene.setListener({ contextLost: () => this.events.fatal('webgl-lost', 'context lost') });
    this.unsubscribeFrame = scene.onFrame((dt, time) => {
      this.tracking.tick();
      this.experience?.update(dt, time);
    });
    return scene;
  }

  /** Loads each poster's content once, and keeps it, so that going back to a poster is instant. */
  private prepareExperience(config: ExperienceConfig, onProgress?: (fraction: number) => void) {
    let loading = this.experiences.get(config.id);
    if (!loading) {
      const experience: Experience =
        config.kind === 'model' ? new TyreExperience(config, this.models!, this.lighting!) : new VideoExperience(config, this.createVideo());
      loading = experience.load(onProgress).then(() => {
        if (this.disposed) {
          experience.dispose();
        } else {
          experience.root.visible = false;
          this.scene!.anchor.add(experience.root);
        }
        return experience;
      });
      this.experiences.set(config.id, loading);
    }
    return loading;
  }

  private createVideo() {
    const video = new ContentVideo();
    video.onBlocked = () => this.events.videoBlocked();
    this.videos.push(video);
    return video;
  }

  /** Readies the other posters behind the scenes, one at a time, so a switch doesn't have to wait. */
  private async warmOtherPosters() {
    if (this.options.deepLink) return;
    for (const config of EXPERIENCES) {
      if (this.disposed) return;
      // A failure here only matters if that poster is found, and is reported then.
      await this.prepareExperience(config).catch(() => undefined);
    }
  }

  private async onFound(index: number) {
    const config = this.options.deepLink ?? EXPERIENCES[index];
    if (!config) return;
    const token = ++this.loadToken;
    this.events.found(config);
    this.events.hotspot(null);
    this.entered = false;
    if (this.experience) {
      this.experience.suspend();
      this.experience.root.visible = false;
      this.experience = null;
    }

    let experience: Experience;
    try {
      experience = await this.prepareExperience(config, (f) => this.events.progress(f, 'Loading content'));
    } catch (err) {
      if (token === this.loadToken) this.events.fatal('asset-load', err);
      return;
    }
    if (this.disposed || token !== this.loadToken) return;
    this.experience = experience;
    this.scene!.anchor.visible = true;
    experience.resume();
    experience.enter();
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

  private readonly onTap = (event: MouseEvent) => {
    if ((event.target as Element).closest('button, a')) return;
    if (this.events.takeVideoBlocked()) {
      this.videos.forEach((video) => video.retry());
      return;
    }
    this.adapter?.tap();
    const experience = this.experience;
    const scene = this.scene;
    if (!experience || !scene || !this.entered) return;
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, scene.camera);
    this.events.hotspot(experience.select(this.raycaster));
  };
}
