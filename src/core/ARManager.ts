import type { PlacementState } from '../adapters/WebXRAdapter';
import { EXPERIENCES, readRuntimeOptions, type ExperienceConfig, type HotspotConfig, type RuntimeOptions } from '../config/experiences';
import { detectCapabilities, supportsImmersiveAR, type Capabilities } from '../services/capabilities';
import { ContentVideo } from '../services/ContentVideo';
import { describeError } from '../services/errors';
import type { ARErrorInfo, ARErrorKind, ARPhase, PoseSample, TrackingStats } from '../types/ar';
import type { ARRuntime } from './ARRuntime';
import { CameraError } from './CameraManager';

export interface ARState {
  phase: ARPhase;
  /** Set when a session runs in immersive WebXR, and drives the placement prompts. */
  placement: PlacementState | null;
  experience: ExperienceConfig | null;
  /** 0..1 progress for the preloader. */
  progress: number;
  progressLabel: string;
  error: ARErrorInfo | null;
  hotspot: HotspotConfig | null;
  canFlip: boolean;
  canPlaceInRoom: boolean;
  /** The browser blocked muted video autoplay (iOS Low Power Mode); a tap is needed. */
  videoBlocked: boolean;
}

const RECOVERED_FLASH_MS = 1400;

const initialState = (options: RuntimeOptions, capabilities: Capabilities): ARState => ({
  phase: capabilities.unsupported ? 'unsupported' : 'welcome',
  placement: null,
  experience: options.deepLink,
  progress: 0,
  progressLabel: '',
  error: null,
  hotspot: null,
  canFlip: false,
  canPlaceInRoom: false,
  videoBlocked: false,
});

/**
 * Application state machine. It maps camera, tracking and content events onto user-facing phases and
 * exposes them as a store for React. React only re-renders on phase-level changes: the per-frame AR
 * path stays entirely in ARRuntime and never passes through here.
 */
export class ARManager {
  readonly options = readRuntimeOptions();
  readonly capabilities = detectCapabilities();
  private state = initialState(this.options, this.capabilities);
  private readonly listeners = new Set<() => void>();

  private runtime: ARRuntime | null = null;
  private readonly video = new ContentVideo();
  private container: HTMLElement | null = null;
  private sessionId = 0;
  private recoveredTimer = 0;
  private poseLog: { t: number; m: number[]; c: number }[] = [];
  private trackedImages: { image: ImageBitmap; widthInMeters: number }[] | null = null;

  constructor() {
    this.video.onBlocked = () => this.set({ videoBlocked: true });
    if (!this.capabilities.unsupported) {
      void supportsImmersiveAR().then((supported) => {
        const placeable = (this.options.deepLink ?? EXPERIENCES.find((e) => e.placeable))?.placeable ?? false;
        this.set({ canPlaceInRoom: supported && placeable });
      });
    }
    window.addEventListener('pagehide', this.onPageHide);
    if (this.options.xrImageTracking) void this.prepareTrackedImages();
    if (this.options.debug) this.installDebugHook();
  }

  getSnapshot = () => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  attachContainer(container: HTMLElement | null) {
    this.container = container;
  }

  /** Preloads the 3D and tracking code once the welcome screen is idle. */
  prefetch() {
    void import('./ARRuntime');
  }

  /** Starts the camera-based experience. Must run from a user gesture. */
  start = async () => {
    this.video.unlock(); // Has to stay synchronous with the tap.
    const session = this.beginSession();
    this.set({ phase: 'permission', error: null, progress: 0, progressLabel: 'Starting', hotspot: null, placement: null, videoBlocked: false });

    try {
      const runtime = await this.createRuntime();
      if (session !== this.sessionId) return runtime.dispose();
      this.runtime = runtime;

      await runtime.startCamera();
      if (session !== this.sessionId) return;
      this.set({ phase: 'initializing', canFlip: await runtime.camera.canFlip() });
      if (session !== this.sessionId) return;

      await runtime.startImageTracking();
      if (session !== this.sessionId) return;
      this.set({ phase: 'scanning' });
    } catch (err) {
      if (session === this.sessionId) this.fail(classify(err), err);
    }
  };

  /** Starts room placement with WebXR hit testing. Must run from a user gesture. */
  placeInRoom = async () => {
    const config = this.options.deepLink ?? EXPERIENCES.find((e) => e.placeable);
    if (!config?.placeable) return;
    const overlay = document.getElementById('ar-overlay') ?? document.body;

    // requestSession must be the first thing that happens in the tap, before anything is awaited.
    const imageTracking = this.trackedImages ? { trackedImages: this.trackedImages } : {};
    const requested = navigator.xr!.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['anchors', 'dom-overlay', 'light-estimation', ...(this.trackedImages ? ['image-tracking'] : [])],
      domOverlay: { root: overlay },
      ...imageTracking,
    } as XRSessionInit);

    this.video.unlock();
    const id = this.beginSession();
    this.set({
      phase: 'initializing',
      experience: config,
      error: null,
      progress: 0,
      progressLabel: 'Starting AR',
      hotspot: null,
      placement: 'searching',
      canFlip: false,
    });

    try {
      const session = await requested;
      const runtime = await this.createRuntime();
      if (id !== this.sessionId) {
        runtime.dispose();
        void session.end();
        return;
      }
      this.runtime = runtime;
      await runtime.startPlacement(session, config);
      if (id !== this.sessionId) return;
      this.set({ phase: 'scanning' });
    } catch (err) {
      if (id === this.sessionId) this.fail('xr-session', err);
    }
  };

  /** Ends the experience. The camera is off by the time this returns. */
  stop = () => {
    this.beginSession();
    this.set({ ...initialState(this.options, this.capabilities), canPlaceInRoom: this.state.canPlaceInRoom });
  };

  retry = () => {
    void this.start();
  };

  flipCamera = async () => {
    const runtime = this.runtime;
    if (!runtime) return;
    try {
      await runtime.flipCamera();
    } catch (err) {
      this.fail(classify(err), err);
    }
  };

  tap = (clientX: number, clientY: number) => {
    if (this.state.videoBlocked) {
      this.set({ videoBlocked: false });
      this.video.retry();
      return;
    }
    this.runtime?.tap(clientX, clientY);
  };

  /**
   * Decodes the posters ahead of time, because the session request can't wait on anything. ARCore
   * reports each poster's measured width, so the starting width only needs to be roughly right.
   * Indices must match target indices, so this mirrors what targetsUrl() would load.
   */
  private async prepareTrackedImages() {
    const list = this.options.deepLink ? [this.options.deepLink] : EXPERIENCES;
    const images = await Promise.all(
      list.map(async (experience) => {
        const blob = await (await fetch(experience.target)).blob();
        return { image: await createImageBitmap(blob, { resizeWidth: 1024 }), widthInMeters: 0.6 };
      }),
    );
    this.trackedImages = images;
  }

  /** Disposes any previous runtime and invalidates its in-flight async work. */
  private beginSession() {
    window.clearTimeout(this.recoveredTimer);
    this.runtime?.dispose();
    this.runtime = null;
    this.sessionId += 1;
    return this.sessionId;
  }

  private async createRuntime() {
    const { ARRuntime } = await import('./ARRuntime');
    if (!this.container) throw new Error('AR container is not mounted');
    return new ARRuntime(this.container, this.options, this.video, {
      progress: (progress, progressLabel) => this.set({ progress, progressLabel }),
      found: (experience) => this.set({ phase: 'detected', experience, hotspot: null }),
      contentReady: () => {
        if (this.state.phase === 'detected') this.set({ phase: 'active' });
      },
      lost: () => {
        window.clearTimeout(this.recoveredTimer);
        if (this.state.phase === 'active' || this.state.phase === 'recovered' || this.state.phase === 'detected') {
          this.set({ phase: 'lost', hotspot: null });
        }
      },
      recovered: () => {
        this.set({ phase: 'recovered' });
        this.recoveredTimer = window.setTimeout(() => {
          if (this.state.phase === 'recovered') this.set({ phase: 'active' });
        }, RECOVERED_FLASH_MS);
      },
      hotspot: (hotspot) => this.set({ hotspot }),
      placementState: (placement) => this.set({ placement }),
      xrEnded: () => this.stop(),
      fatal: (kind, detail) => this.fail(kind, detail),
      pose: this.options.debug ? this.logPose : undefined,
    });
  }

  private fail(kind: ARErrorKind, detail: unknown) {
    console.error(`[AR] ${kind}:`, detail);
    this.beginSession();
    this.set({ phase: 'error', error: describeError(kind, this.capabilities.isIOS), placement: null });
  }

  private set(patch: Partial<ARState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  private readonly onPageHide = (event: PageTransitionEvent) => {
    // A page going into the back/forward cache must not keep the camera light on.
    if (event.persisted && this.runtime) this.stop();
  };

  private readonly logPose = (sample: PoseSample) => {
    if (this.poseLog.length > 20000) this.poseLog.shift();
    this.poseLog.push({ t: sample.time, m: Array.from(sample.matrix.elements), c: sample.confidence });
  };

  private installDebugHook() {
    Object.assign(window, {
      __AR__: {
        state: () => this.state,
        stats: (): (TrackingStats & { renderFps: number }) | null => {
          const stats = this.runtime?.stats();
          return stats ? { ...stats, renderFps: this.runtime!.renderFps } : null;
        },
        poses: () => this.poseLog,
        clearPoses: () => {
          this.poseLog = [];
        },
        cameraActive: () => this.runtime?.camera.active ?? false,
        runtime: () => this.runtime,
      },
    });
  }
}

function classify(err: unknown): ARErrorKind {
  if (err instanceof CameraError) return err.kind;
  return 'tracking-init';
}
