const base = import.meta.env.BASE_URL;
const asset = (path: string) => `${base}assets/${path}`;

export interface HotspotConfig {
  id: string;
  title: string;
  description: string;
  /** Marker position in the GLB's `Tyre` node space (wheel radius is about 1). */
  position: [number, number, number];
  /** Axial band of the tread to light up, as |z| in `Wheel` space. */
  band: [number, number];
}

export interface ExperienceConfig {
  id: string;
  title: string;
  subtitle: string;
  kind: 'model' | 'video';
  /** Target image dimensions. These define the poster's coordinate frame: width 1, centred, +Z out. */
  targetSize: [number, number];
  content: string;
  thumb: string;
  target: string;
  hero?: string;
  logo?: string;
  /** Can also be placed in the room with WebXR hit testing. */
  placeable?: boolean;
  hotspots?: HotspotConfig[];
}

// Order matters: it is the target order inside all.mind (see scripts/compile-targets.mjs).
export const EXPERIENCES: ExperienceConfig[] = [
  {
    id: 'ceat-tyre',
    title: 'CEAT Premium Touring',
    subtitle: 'Grip that goes the extra mile',
    kind: 'model',
    targetSize: [1800, 1000],
    content: asset('experiences/ceat-tyre/content.glb'),
    thumb: asset('experiences/ceat-tyre/thumb.jpg'),
    target: asset('experiences/ceat-tyre/target.jpg'),
    hero: asset('experiences/ceat-tyre/hero.jpg'),
    logo: asset('experiences/ceat-tyre/logo.png'),
    placeable: true,
    // Copy comes straight from the poster's feature panel.
    hotspots: [
      {
        id: 'wet-grip',
        title: 'Wet Grip',
        description: 'Deep grooves channel water away',
        position: [0.985, -0.3, 0.135],
        band: [0.07, 0.168],
      },
      {
        id: 'quiet-ride',
        title: 'Quiet Ride',
        description: 'Optimised pitch for a calmer cabin',
        position: [0.84, 0.56, 0.24],
        band: [0.168, 0.3],
      },
      {
        id: 'long-life',
        title: 'Long Life',
        description: 'Wide centre rib for even wear',
        position: [1.0, 0.2, 0.0],
        band: [0, 0.07],
      },
    ],
  },
  {
    id: 'basketball',
    title: 'Saathi Play',
    subtitle: 'Living poster',
    kind: 'video',
    targetSize: [1480, 2000],
    content: asset('experiences/basketball/content.mp4'),
    thumb: asset('experiences/basketball/thumb.jpg'),
    target: asset('experiences/basketball/target.jpg'),
  },
  {
    id: 'flower',
    title: 'Almond Blossom',
    subtitle: 'Living painting',
    kind: 'video',
    targetSize: [2048, 1618],
    content: asset('experiences/flower/content.mp4'),
    thumb: asset('experiences/flower/thumb.jpg'),
    target: asset('experiences/flower/target.jpg'),
  },
  {
    id: 'jelly',
    title: 'Discomedusae',
    subtitle: 'Living plate',
    kind: 'video',
    targetSize: [1520, 2180],
    content: asset('experiences/jelly/content.mp4'),
    thumb: asset('experiences/jelly/thumb.jpg'),
    target: asset('experiences/jelly/target.jpg'),
  },
  {
    id: 'love',
    title: 'The Kiss',
    subtitle: 'Living painting',
    kind: 'video',
    targetSize: [2048, 2054],
    content: asset('experiences/love/content.mp4'),
    thumb: asset('experiences/love/thumb.jpg'),
    target: asset('experiences/love/target.jpg'),
  },
];

export const experienceById = (id: string | null | undefined) => EXPERIENCES.find((e) => e.id === id) ?? null;

export const targetsUrl = (id: string | null) => asset(`targets/${id ?? 'all'}.mind`);

/** `?fov=` lets a device be calibrated in the field; `?debug` shows live tracking stats. */
export interface RuntimeOptions {
  deepLink: ExperienceConfig | null;
  debug: boolean;
  fovLong: number | null;
  /** Overrides the tier-based tracker input size, for field testing. */
  inputShortSide: number | null;
  /** Disables the pose filter, for measuring raw tracker output. */
  rawPose: boolean;
  /** Asks ARCore for native image tracking in immersive sessions. Needs chrome://flags/#webxr-incubations. */
  xrImageTracking: boolean;
}

export function readRuntimeOptions(search = window.location.search): RuntimeOptions {
  const params = new URLSearchParams(search);
  const fov = Number(params.get('fov'));
  return {
    deepLink: experienceById(params.get('t')),
    debug: params.has('debug'),
    fovLong: Number.isFinite(fov) && fov > 20 && fov < 120 ? fov : null,
    inputShortSide: Number(params.get('input')) || null,
    rawPose: params.has('rawpose'),
    xrImageTracking: params.has('xrimage'),
  };
}
