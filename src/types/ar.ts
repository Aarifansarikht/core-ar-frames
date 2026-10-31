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
  | 'camera-unavailable'
  | 'camera-busy'
  | 'insecure-context'
  | 'tracking-init'
  | 'asset-load'
  | 'webgl-init'
  | 'webgl-lost'
  | 'xr-session'
  | 'unknown';

export interface ARErrorInfo {
  kind: ARErrorKind;
  title: string;
  message: string;
  /** Whether Retry can plausibly succeed without the user changing something first. */
  canRetry: boolean;
}

export type TrackingKind = 'image' | 'webxr';

/** One tracker result. `matrix` is valid only for the synchronous duration of the call. */
export interface PoseSample {
  targetIndex: number;
  /** Content root to camera space (image tracking) or reference space (WebXR). */
  matrix: Matrix4;
  /** 0..1, the share of target features confirmed in this frame. */
  confidence: number;
  /** Capture time of the camera frame, in seconds. */
  time: number;
}

export interface TrackingStats {
  engine: string;
  /** Tracker throughput in frames per second. */
  trackFps: number;
  /** Time spent processing the last frame, in milliseconds. */
  trackMs: number;
  confidence: number;
  inputWidth: number;
  inputHeight: number;
  /** Long-side camera field of view assumed for the pose solve, in degrees. */
  fovLong: number;
}

/** What a tracking adapter reports to TrackingManager. Adapters never touch UI or content. */
export interface TrackingSink {
  pose(sample: PoseSample): void;
  miss(): void;
  /** The session ended for a reason outside our control (e.g. the user left immersive mode). */
  ended(reason?: string): void;
}

/** Tracker-pixel pinhole intrinsics. The principal point is assumed to be the image centre. */
export interface CameraIntrinsics {
  focal: number;
  width: number;
  height: number;
}
