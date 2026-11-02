import type { Object3D } from 'three';

/** A rectangle on a poster, as fractions of its size, from the top left. */
export interface TrackingZone {
  kind: 'track' | 'ignore';
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Moves content relative to its poster. Distances are in poster widths, angles in degrees. */
export interface ContentAdjustment {
  x: number;
  y: number;
  z: number;
  rotateX: number;
  rotateY: number;
  rotateZ: number;
  scale: number;
}

export interface PosterSettings {
  zones: TrackingZone[];
  content: ContentAdjustment;
}

export type TrackingSettings = Record<string, PosterSettings>;

export const NO_ADJUSTMENT: ContentAdjustment = { x: 0, y: 0, z: 0, rotateX: 0, rotateY: 0, rotateZ: 0, scale: 1 };

export const settingsFor = (settings: TrackingSettings, id: string): PosterSettings => ({
  zones: settings[id]?.zones ?? [],
  content: { ...NO_ADJUSTMENT, ...settings[id]?.content },
});

const settingsUrl = () => new URL(`${import.meta.env.BASE_URL}assets/tracking.json`, document.baseURI).href;

/** Settings are optional, so anything wrong with them leaves posters tracked as a whole, with content unmoved. */
export async function loadTrackingSettings(): Promise<TrackingSettings> {
  try {
    const response = await fetch(settingsUrl(), { cache: 'no-store' });
    if (!response.ok) return {};
    return (await response.json()).posters ?? {};
  } catch (err) {
    console.warn('[AR] Tracking settings were not loaded:', err);
    return {};
  }
}

/**
 * Whether a feature counts, given its place on the poster as fractions from the top left. If any zone
 * says `track`, only those areas count. `ignore` zones always win.
 */
export function zoneAllows(zones: TrackingZone[], u: number, v: number) {
  const inside = (zone: TrackingZone) => u >= zone.x && u <= zone.x + zone.width && v >= zone.y && v <= zone.y + zone.height;
  if (zones.some((zone) => zone.kind === 'ignore' && inside(zone))) return false;
  const tracked = zones.filter((zone) => zone.kind === 'track');
  return tracked.length === 0 || tracked.some(inside);
}

const DEGREES = Math.PI / 180;

export function applyContentAdjustment(root: Object3D, { x, y, z, rotateX, rotateY, rotateZ, scale }: ContentAdjustment) {
  root.position.set(x, y, z);
  root.rotation.set(rotateX * DEGREES, rotateY * DEGREES, rotateZ * DEGREES);
  root.scale.setScalar(scale);
}
