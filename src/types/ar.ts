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

export type TrackingKind = '8thwall';

/** One tracker result. `matrix` is valid only for the synchronous duration of the call. */
export interface PoseSample {
  targetIndex: number;
  /** Content root to the engine's world. */
  matrix: Matrix4;
  /** 1 when the engine sees the poster now, 0.5 when it holds the poster's last known place in the room. */
  confidence: number;
  /** Time of the frame, in seconds. */
  time: number;
}

export interface TrackingStats {
  engine: string;
  /** Engine frames per second. */
  trackFps: number;
  confidence: number;
  /** The current poster: tracked (seen now), held (a remembered place) or none. */
  imageState: string;
  /** How the engine is tracking the room: NORMAL or LIMITED. */
  worldState: string;
  /** The current poster's id. */
  target: string;
}

/** What a tracking adapter reports to TrackingManager. Adapters never touch UI or content. */
export interface TrackingSink {
  pose(sample: PoseSample): void;
  miss(): void;
  /** The session ended for a reason outside our control. */
  ended(reason?: string): void;
}
