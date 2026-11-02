import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { EXPERIENCES, targetUrl, type ExperienceConfig } from '../config/experiences';
import {
  loadTrackingSettings,
  NO_ADJUSTMENT,
  settingsFor,
  zoneAllows,
  type ContentAdjustment,
  type PosterSettings,
  type TrackingSettings,
  type TrackingZone,
} from '../config/tracking';
import './admin.css';
import { ContentPreview } from './ContentPreview';

type Tab = 'area' | 'content';
type Status = { tone: 'good' | 'warn' | 'bad'; text: string } | null;

/** Rough guides to how much a poster can lose. Only a test on a phone can confirm them. */
const GOOD_POINTS = 300;
const GOOD_COVER = 0.5;
const WEAK_POINTS = 100;
const WEAK_COVER = 0.3;

const SLIDERS: { key: keyof ContentAdjustment; label: string; min: number; max: number; step: number; unit: string }[] = [
  { key: 'x', label: 'Left / right', min: -1, max: 1, step: 0.002, unit: '' },
  { key: 'y', label: 'Down / up', min: -1, max: 1, step: 0.002, unit: '' },
  { key: 'z', label: 'Into / out of poster', min: -0.5, max: 1, step: 0.002, unit: '' },
  { key: 'rotateX', label: 'Tilt', min: -180, max: 180, step: 0.5, unit: '°' },
  { key: 'rotateY', label: 'Turn', min: -180, max: 180, step: 0.5, unit: '°' },
  { key: 'rotateZ', label: 'Spin', min: -180, max: 180, step: 0.5, unit: '°' },
  { key: 'scale', label: 'Size', min: 0.1, max: 3, step: 0.005, unit: '×' },
];

/** The poster's compiled features, as fractions of its size from the top left. */
async function loadFeatures(config: ExperienceConfig) {
  const response = await fetch(targetUrl(config.id));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const file = await response.arrayBuffer();
  const view = new DataView(file);
  const count = view.getUint32(0, true);
  const aspect = view.getFloat32(4, true);
  const points = new Float32Array(file, 16, count * 2);
  const features: [number, number][] = [];
  for (let i = 0; i < count; i += 1) features.push([points[i * 2] + 0.5, 0.5 - points[i * 2 + 1] / aspect]);
  return features;
}

function rate(used: [number, number][]) {
  const across = used.length ? Math.max(...used.map((p) => p[0])) - Math.min(...used.map((p) => p[0])) : 0;
  const down = used.length ? Math.max(...used.map((p) => p[1])) - Math.min(...used.map((p) => p[1])) : 0;
  const cover = Math.min(across, down);
  if (used.length >= GOOD_POINTS && cover >= GOOD_COVER) return { tone: 'good', text: 'Good' } as const;
  if (used.length >= WEAK_POINTS && cover >= WEAK_COVER) return { tone: 'warn', text: 'Weak: may be slower to find, and less accurate' } as const;
  return { tone: 'bad', text: 'Too little to track reliably: use a larger area' } as const;
}

function TrackingArea({ config, zones, onChange }: { config: ExperienceConfig; zones: TrackingZone[]; onChange(zones: TrackingZone[]): void }) {
  const [features, setFeatures] = useState<[number, number][]>([]);
  const [kind, setKind] = useState<TrackingZone['kind']>('track');
  const [draft, setDraft] = useState<TrackingZone | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const dots = useRef<HTMLCanvasElement>(null);
  const start = useRef<[number, number] | null>(null);

  useEffect(() => {
    let current = true;
    setFeatures([]);
    void loadFeatures(config)
      .then((list) => current && setFeatures(list))
      .catch((err) => console.error('[Admin] Features did not load:', err));
    return () => {
      current = false;
    };
  }, [config]);

  const used = useMemo(() => features.filter(([u, v]) => zoneAllows(zones, u, v)), [features, zones]);
  const rating = rate(used);

  useEffect(() => {
    const canvas = dots.current;
    const box = stage.current;
    if (!canvas || !box) return;
    const draw = () => {
      const ratio = window.devicePixelRatio || 1;
      canvas.width = box.clientWidth * ratio;
      canvas.height = box.clientHeight * ratio;
      const ctx = canvas.getContext('2d')!;
      for (const [u, v] of features) {
        ctx.fillStyle = zoneAllows(zones, u, v) ? '#3ddc97' : 'rgba(255,255,255,0.3)';
        ctx.beginPath();
        ctx.arc(u * canvas.width, v * canvas.height, 2 * ratio, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(box);
    return () => observer.disconnect();
  }, [features, zones]);

  const position = (event: ReactPointerEvent): [number, number] => {
    const rect = stage.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))];
  };
  const rectangle = (a: [number, number], b: [number, number]): TrackingZone => ({
    kind,
    x: Math.min(a[0], b[0]),
    y: Math.min(a[1], b[1]),
    width: Math.abs(a[0] - b[0]),
    height: Math.abs(a[1] - b[1]),
  });

  return (
    <>
      <div className="admin__stage">
        <div
          ref={stage}
          className="admin__poster"
          data-testid="poster-area"
          style={{ aspectRatio: `${config.targetSize[0]} / ${config.targetSize[1]}` }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            start.current = position(event);
          }}
          onPointerMove={(event) => {
            if (start.current) setDraft(rectangle(start.current, position(event)));
          }}
          onPointerUp={(event) => {
            if (!start.current) return;
            const zone = rectangle(start.current, position(event));
            start.current = null;
            setDraft(null);
            if (zone.width > 0.01 && zone.height > 0.01) onChange([...zones, zone]);
          }}
        >
          <img src={config.target} alt={`${config.title} poster`} draggable={false} />
          <canvas ref={dots} aria-hidden="true" />
          {[...zones, ...(draft ? [draft] : [])].map((zone, i) => (
            <div
              key={i}
              className={`admin__zone admin__zone--${zone.kind}`}
              style={{ left: `${zone.x * 100}%`, top: `${zone.y * 100}%`, width: `${zone.width * 100}%`, height: `${zone.height * 100}%` }}
            />
          ))}
        </div>
      </div>

      <aside className="admin__controls">
        <h2>Tracking area</h2>
        <p className="admin__help">Drag on the poster to mark an area. Green dots are the points used to track it.</p>
        <fieldset className="admin__choice">
          <legend>Next area you draw</legend>
          <label>
            <input type="radio" name="zone-kind" checked={kind === 'track'} onChange={() => setKind('track')} /> Track only here
          </label>
          <label>
            <input type="radio" name="zone-kind" checked={kind === 'ignore'} onChange={() => setKind('ignore')} /> Ignore this
          </label>
        </fieldset>

        <p className="admin__stat">
          <strong data-testid="points-used">{used.length}</strong> of {features.length} points used
        </p>
        <p className={`admin__rating admin__rating--${rating.tone}`} data-testid="rating">
          {rating.text}
        </p>

        {zones.length > 0 && (
          <ul className="admin__zones">
            {zones.map((zone, i) => (
              <li key={i}>
                <span>
                  {zone.kind === 'track' ? 'Track' : 'Ignore'}: {Math.round(zone.width * 100)}% × {Math.round(zone.height * 100)}%
                </span>
                <button type="button" onClick={() => onChange(zones.filter((_, n) => n !== i))} aria-label={`Remove area ${i + 1}`}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <button type="button" className="admin__button" onClick={() => onChange([])} disabled={zones.length === 0}>
          Track the whole poster
        </button>
      </aside>
    </>
  );
}

function ContentControls({ config, content, onChange }: { config: ExperienceConfig; content: ContentAdjustment; onChange(content: ContentAdjustment): void }) {
  return (
    <>
      <div className="admin__stage">
        <ContentPreview config={config} content={content} />
      </div>
      <aside className="admin__controls">
        <h2>Content position</h2>
        <p className="admin__help">Line the content up with the print. Drag the preview to look around it. Distances are in poster widths.</p>
        {SLIDERS.map(({ key, label, min, max, step, unit }) => (
          <label className="admin__slider" key={key}>
            <span>{label}</span>
            <input type="range" aria-label={label} min={min} max={max} step={step} value={content[key]} onChange={(event) => onChange({ ...content, [key]: Number(event.target.value) })} />
            <input type="number" aria-label={`${label} value`} min={min} max={max} step={step} value={content[key]} onChange={(event) => onChange({ ...content, [key]: Number(event.target.value) })} />
            <em>{unit}</em>
          </label>
        ))}
        <button type="button" className="admin__button" onClick={() => onChange(NO_ADJUSTMENT)}>
          Reset position
        </button>
      </aside>
    </>
  );
}

/** Saves into the project when run by the dev server, which is the only place that can write there. */
async function save(settings: TrackingSettings): Promise<Status> {
  const body = `${JSON.stringify({ posters: settings }, null, 2)}\n`;
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}__admin/tracking`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    if (response.ok) return { tone: 'good', text: 'Saved to the project. Commit and push to publish it.' };
  } catch {
    // Falls through to the download below.
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
  link.download = 'tracking.json';
  link.click();
  URL.revokeObjectURL(link.href);
  return { tone: 'warn', text: 'Downloaded tracking.json. Replace public/assets/tracking.json with it, then push to publish it.' };
}

export function AdminPanel() {
  const [settings, setSettings] = useState<TrackingSettings | null>(null);
  const [selected, setSelected] = useState(EXPERIENCES[0]);
  const [tab, setTab] = useState<Tab>('area');
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  useEffect(() => {
    void loadTrackingSettings().then(setSettings);
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (!settings) return <main className="admin admin--loading">Loading…</main>;
  const poster = settingsFor(settings, selected.id);
  const update = (patch: Partial<PosterSettings>) => {
    setSettings({ ...settings, [selected.id]: { ...poster, ...patch } });
    setDirty(true);
    setStatus(null);
  };

  return (
    <main className="admin">
      <header className="admin__bar">
        <h1>BAY81 AR admin</h1>
        <div className="admin__actions">
          <a className="admin__button" href={`?t=${selected.id}`} target="_blank" rel="noreferrer">
            Test with camera
          </a>
          <button
            type="button"
            className="admin__button admin__button--primary"
            disabled={!dirty}
            onClick={() =>
              void save(settings).then((result) => {
                setStatus(result);
                setDirty(false);
              })
            }
          >
            {dirty ? 'Save changes' : 'Saved'}
          </button>
        </div>
      </header>
      {status && (
        <p className={`admin__status admin__rating--${status.tone}`} role="status">
          {status.text}
        </p>
      )}

      <nav className="admin__posters" aria-label="Posters">
        {EXPERIENCES.map((experience) => (
          <button type="button" key={experience.id} aria-pressed={experience.id === selected.id} onClick={() => setSelected(experience)}>
            <img src={experience.thumb} alt="" />
            <span>{experience.title}</span>
          </button>
        ))}
      </nav>

      <div className="admin__tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'area'} onClick={() => setTab('area')}>
          Tracking area
        </button>
        <button type="button" role="tab" aria-selected={tab === 'content'} onClick={() => setTab('content')}>
          Content position
        </button>
      </div>

      <section className="admin__work">
        {tab === 'area' ? (
          <TrackingArea config={selected} zones={poster.zones} onChange={(zones) => update({ zones })} />
        ) : (
          <ContentControls key={selected.id} config={selected} content={poster.content} onChange={(content) => update({ content })} />
        )}
      </section>
    </main>
  );
}
