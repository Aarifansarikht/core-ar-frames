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
  | 'motion-denied'
  | 'camera-failed'
  | 'tracking-init'
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

export type TrackingKind = 'vision';

/** One tracker result. `matrix` is valid only for the synchronous duration of the call. */
export interface PoseSample {
  targetIndex: number;
  /** Content root to the scene's world. For posters, that is the camera's own frame. */
  matrix: Matrix4;
  confidence: number;
  /** Time of the frame, in seconds. */
  time: number;
}

export interface TrackingStats {
  engine: string;
  /** Frames the tracker gets through per second. */
  trackFps: number;
  confidence: number;
  /** The current poster: tracked or none. */
  imageState: string;
  /** What the tracker did last: search, follow or refine. Or room. */
  mode: string;
  /** The current poster, as its place in the list of targets, or -1. */
  target: number;
  /** Points that agreed with the pose. */
  points: number;
  /** How long the last frame took to process, in milliseconds. */
  frameMs: number;
}

/** What a tracking adapter reports to TrackingManager. Adapters never touch UI or content. */
export interface TrackingSink {
  pose(sample: PoseSample): void;
  miss(): void;
  /** The session ended for a reason outside our control. */
  ended(reason?: string): void;
}
