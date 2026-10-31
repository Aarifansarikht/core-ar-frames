import type { Matrix4 } from 'three';

/** The ten user-facing states of the experience. Drives the UI and nothing else. */
export type ARPhase =
  | 'welcome'
  | 'permission'
  | 'initializing'
  | 'scanning'
  | 'detected'
  | 'active'
  | 'lost'
  | 'recovered'
  | 'unsupported'
  | 'error';

export type ARErrorKind =
  | 'camera-denied'
  | 'xr-camera'
  | 'tracking-init'
  | 'xr-session'
  | 'asset-load'
  | 'webgl-init'
  | 'webgl-lost'
  | 'unknown';

export interface ARErrorInfo {
  kind: ARErrorKind;
  title: string;
  message: string;
  /** Whether Retry can plausibly succeed without the user changing something first. */
  canRetry: boolean;
}

export type TrackingKind = 'webxr';

/** One tracker result. `matrix` is valid only for the synchronous duration of the call. */
export interface PoseSample {
  targetIndex: number;
  /** Content root to the WebXR reference space. */
  matrix: Matrix4;
  /** 1 when ARCore sees the poster now, 0.5 when it holds the poster's last known place in the room. */
  confidence: number;
  /** Time of the XR frame, in seconds. */
  time: number;
}

export interface TrackingStats {
  engine: string;
  /** XR frames per second. */
  trackFps: number;
  confidence: number;
  /** The current poster: tracked (seen now), emulated (a remembered place) or none. */
  imageState: string;
  /** ARCore's verdict on each poster's detail, in list order. Only with its own image tracking. */
  imageScores: string[];
  /** The poster width measured so far, in metres. */
  measuredWidth: number;
  /** Time taken by the last recognition, in milliseconds. Only without ARCore's own image tracking. */
  recogniseMs: number;
}

/** What a tracking adapter reports to TrackingManager. Adapters never touch UI or content. */
export interface TrackingSink {
  pose(sample: PoseSample): void;
  miss(): void;
  /** The session ended for a reason outside our control (e.g. the user left immersive mode). */
  ended(reason?: string): void;
}
