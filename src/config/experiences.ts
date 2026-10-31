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

// Order matters: ARCore reports a found poster by its index in the list given to the session.
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

/** Used when `?w=` doesn't give the print's real width. ARCore locks and scales best with the true value. */
const DEFAULT_PRINT_WIDTH_METERS = 0.6;

/** `?w=` gives the printed width in metres; `?debug` shows live tracking stats. */
export interface RuntimeOptions {
  deepLink: ExperienceConfig | null;
  debug: boolean;
  printWidthMeters: number;
}

export function readRuntimeOptions(search = window.location.search): RuntimeOptions {
  const params = new URLSearchParams(search);
  const width = Number(params.get('w'));
  return {
    deepLink: experienceById(params.get('t')),
    debug: params.has('debug'),
    printWidthMeters: width > 0 && width < 20 ? width : DEFAULT_PRINT_WIDTH_METERS,
  };
}
