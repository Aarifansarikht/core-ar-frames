import type { TrackingKind, TrackingSink, TrackingStats } from '../types/ar';

/**
 * The seam between tracking engines and the rest of the app. Rendering and content only ever see
 * poses delivered through a TrackingSink, so neither knows which engine is running.
 */
export interface TrackingAdapter {
  readonly kind: TrackingKind;
  start(sink: TrackingSink): Promise<void>;
  /** Stops processing and releases GPU and worker resources. Safe to call more than once. */
  stop(): void;
  stats(): TrackingStats;
}
