import type { Object3D, Raycaster } from 'three';
import type { HotspotConfig } from '../config/experiences';

export type SurfaceKind = 'floor' | 'wall';

/** How a piece of content sits on a real surface when placed in the room. */
export interface PlacementSpec {
  /** Content units to metres. */
  scale: number;
  /** The content-frame point that should touch the surface. */
  contactPoint(surface: SurfaceKind): [number, number, number];
}

/**
 * Something that lives on the tracked anchor. Experiences are rendered the same way regardless of
 * which engine positions the anchor, so they contain no tracking or platform code.
 */
export interface Experience {
  readonly root: Object3D;
  readonly placement: PlacementSpec | null;
  load(onProgress?: (fraction: number) => void): Promise<void>;
  /** First time on the target: plays the intro. */
  enter(): void;
  /** Tracking dropped out: hide and hold the animation position. */
  suspend(): void;
  /** Tracking came back: show again and continue from where it stopped. */
  resume(): void;
  update(dt: number, time: number): void;
  /** Hit-tests hotspots against a ray. Returns the selected one, or null if it cleared the selection. */
  select(raycaster: Raycaster): HotspotConfig | null;
  /** Adapts content authored for a poster to free-standing placement. */
  usePlacement(surface: SurfaceKind): void;
  dispose(): void;
}
