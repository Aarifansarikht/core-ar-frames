import type { PlacementState } from '../adapters/WebXRAdapter';
import { EXPERIENCES, readRuntimeOptions, type ExperienceConfig, type HotspotConfig, type RuntimeOptions } from '../config/experiences';
import { detectCapabilities, supportsImmersiveAR, type Capabilities } from '../services/capabilities';
import { CameraAccessError, describeError } from '../services/errors';
import type { ARErrorInfo, ARErrorKind, ARPhase, PoseSample, TrackingStats } from '../types/ar';
import type { ARRuntime } from './ARRuntime';

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
  canPlaceInRoom: boolean;
  /** The poster images are decoded, so a tap can start a session. */
  ready: boolean;
  /** The browser blocked muted video autoplay; a tap is needed. */
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
  canPlaceInRoom: false,
  ready: false,
  videoBlocked: false,
});

/**
 * Application state machine. It maps camera, tracking and content events onto user-facing phases and
 * exposes them as a store for React. React only re-renders on phase-level changes: the per-frame AR
 * path stays entirely in ARRuntime and never passes through here.
 */
export class ARManager {
  readonly options = readRuntimeOptions();
  capabilities = detectCapabilities();
  private state = initialState(this.options, this.capabilities);
  private readonly listeners = new Set<() => void>();

  private runtime: ARRuntime | null = null;
  private container: HTMLElement | null = null;
  private sessionId = 0;
  private recoveredTimer = 0;
  private poseLog: { t: number; m: number[]; c: number }[] = [];
  private trackedImages: { image: ImageBitmap; widthInMeters: number }[] | null = null;

  constructor() {
    if (!this.capabilities.unsupported) {
      void supportsImmersiveAR().then((supported) => {
        if (!supported) {
          this.capabilities = { ...this.capabilities, unsupported: 'no-arcore' };
          this.set({ phase: 'unsupported' });
          return;
        }
        const placeable = (this.options.deepLink ?? EXPERIENCES.find((e) => e.placeable))?.placeable ?? false;
        this.set({ canPlaceInRoom: placeable });
        void this.prepareTrackedImages();
      });
    }
    window.addEventListener('pagehide', this.onPageHide);
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

  /** Starts ARCore poster tracking. Must run from a user gesture. */
  start = async () => {
    const trackedImages = this.trackedImages;
    if (!trackedImages) return;
    // requestSession must be the first thing that happens in the tap, before anything is awaited.
    const requested = navigator.xr!.requestSession('immersive-ar', {
      // ARCore's own image tracking if Chrome offers it, otherwise the camera image for the recogniser.
      optionalFeatures: ['image-tracking', 'camera-access', 'dom-overlay'],
      domOverlay: { root: document.getElementById('ar-overlay') ?? document.body },
      trackedImages,
    } as XRSessionInit);

    const id = this.beginSession();
    this.set({ phase: 'permission', error: null, progress: 0, progressLabel: 'Starting', hotspot: null, placement: null, videoBlocked: false });

    await this.runSession(requested, id, (runtime, session) => runtime.startPosterTracking(session));
  };

  /** Starts room placement with WebXR hit testing. Must run from a user gesture. */
  placeInRoom = async () => {
    const config = this.options.deepLink ?? EXPERIENCES.find((e) => e.placeable);
    if (!config?.placeable) return;

    // requestSession must be the first thing that happens in the tap, before anything is awaited.
    const requested = navigator.xr!.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['anchors', 'dom-overlay', 'light-estimation'],
      domOverlay: { root: document.getElementById('ar-overlay') ?? document.body },
    });

    const id = this.beginSession();
    this.set({
      phase: 'permission',
      experience: config,
      error: null,
      progress: 0,
      progressLabel: 'Starting AR',
      hotspot: null,
      placement: 'searching',
    });

    await this.runSession(requested, id, (runtime, session) => runtime.startPlacement(session, config));
  };

  /** Ends the experience. The camera is off by the time this returns. */
  stop = () => {
    this.beginSession();
    this.set({ ...initialState(this.options, this.capabilities), canPlaceInRoom: this.state.canPlaceInRoom, ready: !!this.trackedImages });
  };

  retry = () => {
    if (this.trackedImages) {
      void this.start();
    } else {
      this.stop();
      void this.prepareTrackedImages();
    }
  };

  /** Waits for the requested session, then hands it to a new runtime. */
  private async runSession(
    requested: Promise<XRSession>,
    id: number,
    begin: (runtime: ARRuntime, session: XRSession) => Promise<void>,
  ) {
    let session: XRSession;
    try {
      session = await requested;
    } catch (err) {
      if (id !== this.sessionId) return;
      const name = err instanceof DOMException ? err.name : '';
      this.fail(name === 'NotAllowedError' || name === 'SecurityError' ? 'camera-denied' : 'xr-session', err);
      return;
    }
    if (id !== this.sessionId) {
      void session.end();
      return;
    }
    // Leaving AR with the system back gesture can happen at any point, including while content loads.
    session.addEventListener('end', () => {
      if (id === this.sessionId) this.stop();
    });

    this.set({ phase: 'initializing' });
    try {
      const runtime = await this.createRuntime();
      if (id !== this.sessionId) {
        runtime.dispose();
        void session.end().catch(() => undefined);
        return;
      }
      this.runtime = runtime;
      await begin(runtime, session);
      if (id === this.sessionId && this.state.phase === 'initializing') this.set({ phase: 'scanning' });
    } catch (err) {
      void session.end().catch(() => undefined);
      if (id === this.sessionId) this.fail(err instanceof CameraAccessError ? 'xr-camera' : 'xr-session', err);
    }
  }

  /**
   * Decodes the posters ahead of time, because the session request can't wait on anything. They are
   * only used if Chrome grants ARCore's own image tracking, which reports posters by index in this list.
   */
  private async prepareTrackedImages() {
    const list = this.options.deepLink ? [this.options.deepLink] : EXPERIENCES;
    try {
      this.trackedImages = await Promise.all(
        list.map(async (experience) => {
          const response = await fetch(experience.target);
          if (!response.ok) throw new Error(`${experience.target}: HTTP ${response.status}`);
          const image = await createImageBitmap(await response.blob(), { resizeWidth: 1024 });
          return { image, widthInMeters: this.options.printWidthMeters };
        }),
      );
      this.set({ ready: true });
    } catch (err) {
      if (this.state.phase === 'welcome') this.fail('asset-load', err);
    }
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
    return new ARRuntime(this.container, this.options, {
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
      videoBlocked: () => this.set({ videoBlocked: true }),
      takeVideoBlocked: () => {
        if (!this.state.videoBlocked) return false;
        this.set({ videoBlocked: false });
        return true;
      },
      fatal: (kind, detail) => this.fail(kind, detail),
      pose: this.options.debug ? this.logPose : undefined,
    });
  }

  private fail(kind: ARErrorKind, detail: unknown) {
    console.error(`[AR] ${kind}:`, detail);
    this.beginSession();
    this.set({ phase: 'error', error: describeError(kind), placement: null });
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
        runtime: () => this.runtime,
      },
    });
  }
}
