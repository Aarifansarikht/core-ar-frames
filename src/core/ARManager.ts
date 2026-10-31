import type { PlacementState } from '../adapters/VisionAdapter';
import { EXPERIENCES, opencvUrl, readRuntimeOptions, targetUrl, type ExperienceConfig, type HotspotConfig, type RuntimeOptions } from '../config/experiences';
import { detectCapabilities, type Capabilities } from '../services/capabilities';
import { describeError, EngineError } from '../services/errors';
import { requestMotionAccess } from '../services/motion';
import { TrackerClient } from '../tracking/TrackerClient';
import type { ARErrorInfo, ARErrorKind, ARPhase, PoseSample, TrackingStats } from '../types/ar';
import type { ARRuntime } from './ARRuntime';

export interface ARState {
  phase: ARPhase;
  /** Set while a session runs, and drives the placement prompts. */
  placement: PlacementState | null;
  experience: ExperienceConfig | null;
  /** 0..1 progress for the preloader. */
  progress: number;
  progressLabel: string;
  error: ARErrorInfo | null;
  hotspot: HotspotConfig | null;
  canPlaceInRoom: boolean;
  /** The tracker has loaded, so a tap can start a session. */
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
  private tracker: TrackerClient | null = null;

  constructor() {
    if (!this.capabilities.unsupported) void this.prepare();
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

  /** Starts poster tracking. Must run from a user gesture. */
  start = async () => {
    if (!this.tracker) return;

    const id = this.beginSession();
    this.set({ phase: 'permission', error: null, progress: 0, progressLabel: 'Starting', hotspot: null, placement: null, videoBlocked: false });

    await this.runSession(Promise.resolve(true), id, (runtime) => runtime.startPosterTracking());
  };

  /** Starts placing content on the floor. Must run from a user gesture. */
  placeInRoom = async () => {
    const config = this.options.deepLink ?? EXPERIENCES.find((e) => e.placeable);
    if (!config?.placeable || !this.tracker) return;
    const motion = requestMotionAccess(); // Must happen in the tap, before anything is awaited.

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

    await this.runSession(motion, id, (runtime) => runtime.startPlacement(config));
  };

  /** Ends the experience. The camera is off by the time this returns. */
  stop = () => {
    this.beginSession();
    this.set({ ...initialState(this.options, this.capabilities), canPlaceInRoom: this.state.canPlaceInRoom, ready: !!this.tracker });
  };

  retry = () => {
    if (this.tracker) {
      void this.start();
    } else {
      this.stop();
      void this.prepare();
    }
  };

  /** Waits for any motion prompt, then hands over to a new runtime. */
  private async runSession(motion: Promise<boolean>, id: number, begin: (runtime: ARRuntime) => Promise<void>) {
    if (!(await motion)) {
      if (id === this.sessionId) this.fail('motion-denied', 'motion access was refused');
      return;
    }
    if (id !== this.sessionId) return;

    try {
      const runtime = await this.createRuntime();
      if (id !== this.sessionId) {
        runtime.dispose();
        return;
      }
      this.runtime = runtime;
      await begin(runtime);
      if (id === this.sessionId && (this.state.phase === 'permission' || this.state.phase === 'initializing')) this.set({ phase: 'scanning' });
    } catch (err) {
      if (id === this.sessionId) this.fail(err instanceof EngineError ? err.kind : 'camera-failed', err);
    }
  }

  /** Loads the tracker before it's needed, so that the session can start as soon as the user asks. */
  private async prepare() {
    const list = this.options.deepLink ? [this.options.deepLink] : EXPERIENCES;
    const tracker = new TrackerClient(
      opencvUrl(),
      list.map(({ id }) => targetUrl(id)),
    );
    try {
      await tracker.whenReady();
      this.tracker = tracker;
      const placeable = (this.options.deepLink ?? EXPERIENCES.find((e) => e.placeable))?.placeable ?? false;
      this.set({ ready: true, canPlaceInRoom: placeable && this.capabilities.hasMotion });
    } catch (err) {
      tracker.dispose();
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
    return new ARRuntime(this.container, this.tracker!, this.options, {
      cameraGranted: () => {
        if (this.state.phase === 'permission') this.set({ phase: 'initializing' });
      },
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
      ended: () => this.stop(),
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
