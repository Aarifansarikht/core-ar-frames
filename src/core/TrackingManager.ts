import type { TrackingAdapter } from '../adapters/TrackingAdapter';
import type { PoseSample, TrackingSink, TrackingStats } from '../types/ar';

export interface TrackingListener {
  /** A target has been confirmed over several consecutive frames. */
  found(targetIndex: number): void;
  /** Fires for every pose once a target is confirmed. */
  pose(sample: PoseSample): void;
  /** Tracking was out for longer than a brief dropout. */
  lost(): void;
  /** The same target came back after being lost. */
  recovered(targetIndex: number): void;
  ended(reason?: string): void;
}

/** The engine has already confirmed an image before reporting it, so content appears on its first pose. */
const WARMUP_FRAMES = 1;
/** Rides out hands, glare and motion blur without flicker, and is short enough to feel responsive. */
const HOLD_MS = 450;

type State = 'idle' | 'candidate' | 'tracking' | 'holding' | 'lost';

/**
 * Turns raw per-frame tracker output from any adapter into stable found / lost / recovered events.
 * Sits between adapters and everything else, so all engines behave alike to the app.
 */
export class TrackingManager implements TrackingSink {
  private adapter: TrackingAdapter | null = null;
  private state: State = 'idle';
  private target = -1;
  private confirmedTarget = -1;
  private candidateFrames = 0;
  private lastPoseAt = 0;

  constructor(private readonly listener: TrackingListener) {}

  async start(adapter: TrackingAdapter) {
    this.stop();
    this.adapter = adapter;
    this.reset();
    await adapter.start(this);
  }

  stop() {
    this.adapter?.stop();
    this.adapter = null;
    this.reset();
  }

  stats(): TrackingStats | null {
    return this.adapter?.stats() ?? null;
  }

  pose(sample: PoseSample) {
    if (this.state === 'tracking' && sample.targetIndex === this.target) {
      this.lastPoseAt = performance.now();
      this.listener.pose(sample);
      return;
    }

    if (sample.targetIndex !== this.target) {
      this.target = sample.targetIndex;
      this.candidateFrames = 0;
      if (this.state !== 'lost') this.state = 'candidate';
    }
    this.candidateFrames += 1;
    if (this.state === 'holding') {
      this.state = 'tracking';
      this.lastPoseAt = performance.now();
      this.listener.pose(sample);
      return;
    }
    if (this.candidateFrames < WARMUP_FRAMES) {
      if (this.state === 'idle') this.state = 'candidate';
      return;
    }

    const returning = this.state === 'lost' && this.confirmedTarget === sample.targetIndex;
    this.state = 'tracking';
    this.confirmedTarget = sample.targetIndex;
    this.lastPoseAt = performance.now();
    if (returning) this.listener.recovered(sample.targetIndex);
    else this.listener.found(sample.targetIndex);
    this.listener.pose(sample);
  }

  miss() {
    this.candidateFrames = 0;
    if (this.state === 'candidate') {
      this.state = 'idle';
      this.target = -1;
    } else if (this.state === 'tracking') {
      this.state = 'holding';
    }
    this.checkHold();
  }

  ended(reason?: string) {
    this.listener.ended(reason);
  }

  /** Called every render frame, so losing a target is noticed even if the tracker goes quiet. */
  tick() {
    if (this.state === 'tracking' && performance.now() - this.lastPoseAt > HOLD_MS) this.state = 'holding';
    this.checkHold();
  }

  private checkHold() {
    if (this.state !== 'holding' || performance.now() - this.lastPoseAt < HOLD_MS) return;
    this.state = 'lost';
    this.target = -1;
    this.listener.lost();
  }

  private reset() {
    this.state = 'idle';
    this.target = -1;
    this.confirmedTarget = -1;
    this.candidateFrames = 0;
    this.lastPoseAt = 0;
  }
}
