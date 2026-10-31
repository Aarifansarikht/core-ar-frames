// Runs the production build in real Chrome with generated camera footage (see make-test-footage.mjs)
// and scores the tracker's output against the known camera path. The whole stack is exercised:
// getUserMedia, MindAR, the pose filter and frame-locked rendering.
//
//   node scripts/test-tracking.mjs <experience-id> [--query "kf=1"] [--shots] [--label name]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const id = args[0] ?? 'ceat-tyre';
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const extraQuery = opt('query', '');
const label = opt('label', 'default');
const wantShots = args.includes('--shots');
const footageId = opt('footage', id);
const out = join(root, '.test-output');
mkdirSync(out, { recursive: true });

const truth = JSON.parse(readFileSync(join(out, `${footageId}.truth.json`), 'utf8'));
const footage = join(out, `${footageId}.y4m`);

const server = await preview({ root, preview: { port: 5177, strictPort: true }, logLevel: 'error' });
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: [
    '--use-angle=d3d11',
    '--ignore-gpu-blocklist',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream=fps=30',
    `--use-file-for-fake-video-capture=${footage}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: false });
const page = await context.newPage();
// Chrome's fake device crops to satisfy constraints, where a phone would rotate its frames instead.
await page.addInitScript(([w, h]) => {
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = () => original({ audio: false, video: { width: { exact: w }, height: { exact: h } } });
}, [truth.W, truth.H]);
// Reads the barcode from each camera frame as it arrives and records it against that frame's time,
// which is the same time the adapter stamps on the pose.
await page.addInitScript(({ bits, block, height }) => {
  const canvas = document.createElement('canvas');
  canvas.width = bits * block;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const ids = (window.__frameIds = new Map());
  const original = HTMLVideoElement.prototype.requestVideoFrameCallback;
  HTMLVideoElement.prototype.requestVideoFrameCallback = function (cb) {
    return original.call(this, (now, meta) => {
      if (this.srcObject) {
        ctx.drawImage(this, 0, 0, canvas.width, height, 0, 0, canvas.width, height);
        const { data } = ctx.getImageData(0, 0, canvas.width, height);
        let id = 0;
        for (let bit = 0; bit < bits; bit++) {
          const i = (((height >> 1) * canvas.width + Math.round((bit + 0.5) * block)) * 4);
          if (data[i] > 128) id |= 1 << bit;
        }
        ids.set(meta.captureTime !== undefined ? meta.captureTime / 1000 : now / 1000, id);
      }
      cb(now, meta);
    });
  };
}, truth.code);
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});

const url = `http://localhost:5177/?t=${id}&debug&fov=${truth.fovLong}${extraQuery ? `&${extraQuery}` : ''}`;
await page.goto(url);
await page.getByRole('button', { name: 'Start AR' }).click();

const startedAt = Date.now();
await page.waitForFunction(() => window.__AR__?.state().phase === 'scanning', null, { timeout: 90000 });
const initMs = Date.now() - startedAt;

// Sample the phase timeline while the footage loops at least once.
const phases = [];
let last = null;
const totalMs = (truth.duration + 8) * 1000;
const t0 = Date.now();
const shots = [];
while (Date.now() - t0 < totalMs) {
  const phase = await page.evaluate(() => window.__AR__.state().phase);
  if (phase !== last) {
    phases.push({ at: (Date.now() - t0) / 1000, phase });
    last = phase;
  }
  if (wantShots && phase === 'active' && shots.length < 6 && (shots.length === 0 || Date.now() - shots.at(-1) > 2500)) {
    await page.screenshot({ path: join(out, `${label}-${id}-${shots.length}.png`) });
    shots.push(Date.now());
  }
  await page.waitForTimeout(100);
}

const { poses, stats, frameIds } = await page.evaluate(() => ({ poses: window.__AR__.poses(), stats: window.__AR__.stats(), frameIds: [...window.__frameIds] }));
const frameOf = new Map(frameIds);

// Clean exit must leave the camera off.
await page.getByRole('button', { name: 'Close' }).click();
await page.waitForFunction(() => window.__AR__.state().phase === 'welcome', null, { timeout: 5000 });
await page.waitForTimeout(700);
const cameraAfterClose = await page.evaluate(() => ({
  runtime: window.__AR__.runtime() !== null,
  videos: [...document.querySelectorAll('video')].filter((v) => v.srcObject).length,
}));

await browser.close();
await server.close();

// ---- Scoring ----
const { W, H, FPS, focal, aspect, duration, frames } = truth;
const corners = [
  [-0.5, aspect / 2],
  [0.5, aspect / 2],
  [0.5, -aspect / 2],
  [-0.5, -aspect / 2],
];
const scale = W / stats.inputWidth; // Tracker-input pixels to footage pixels (the aspect is the same).
const fInput = focal / scale;

const project = (m) =>
  corners.map(([x, y]) => {
    const cx = m[0] * x + m[4] * y + m[12];
    const cy = m[1] * x + m[5] * y + m[13];
    const cz = m[2] * x + m[6] * y + m[14];
    return [W / 2 + (((fInput * cx) / -cz) * scale), H / 2 - (((fInput * cy) / -cz) * scale)];
  });

const samples = poses
  .map((p) => ({ frame: frameOf.get(p.t), c: p.c, corners: project(p.m) }))
  .filter((s) => s.frame !== undefined && s.frame < frames.length);
const unmatched = poses.length - samples.length;

const errorOf = (sample) => {
  const truthCorners = frames[sample.frame].corners;
  let sum = 0;
  for (let i = 0; i < 4; i++) sum += Math.hypot(sample.corners[i][0] - truthCorners[i][0], sample.corners[i][1] - truthCorners[i][1]);
  return sum / 4;
};
const median = (list) => {
  const s = [...list].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : NaN;
};
const percentile = (list, q) => {
  const s = [...list].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : NaN;
};

const footageTime = (s) => s.frame / FPS;

const inRange = (a, b) => samples.filter((s) => footageTime(s) >= a && footageTime(s) < b);
const accuracy = (list) => {
  const errs = list.map(errorOf);
  return { n: list.length, medianPx: +median(errs).toFixed(2), p95Px: +percentile(errs, 0.95).toFixed(2) };
};

// Jitter on the steady segment: spread of the signed corner error about its own mean. Scoring against
// the truth means the footage's hand tremor doesn't count as jitter, only what the tracker adds does.
// Scored on one pass through the footage only: each pass can settle on a slightly different pose, and
// pooling them would report that difference as if it were frame-to-frame noise.
const stillAll = inRange(3, 6.8);
const passEnd = stillAll.findIndex((s, i) => i > 0 && s.frame < stillAll[i - 1].frame);
const still = passEnd > 0 ? stillAll.slice(0, passEnd) : stillAll;
const signedError = (s, i) => [s.corners[i][0] - frames[s.frame].corners[i][0], s.corners[i][1] - frames[s.frame].corners[i][1]];
const meanError = [0, 1, 2, 3].map((i) => [
  still.reduce((a, s) => a + signedError(s, i)[0], 0) / still.length,
  still.reduce((a, s) => a + signedError(s, i)[1], 0) / still.length,
]);
const spread = still.map((s) => [0, 1, 2, 3].reduce((a, i) => {
  const [x, y] = signedError(s, i);
  return a + Math.hypot(x - meanError[i][0], y - meanError[i][1]);
}, 0) / 4);
const steps = still.slice(1).map((s, k) => [0, 1, 2, 3].reduce((a, i) => {
  const [x, y] = signedError(s, i);
  const [px, py] = signedError(still[k], i);
  return a + Math.hypot(x - px, y - py);
}, 0) / 4);

const lostSegment = inRange(16.9, 17.9);

// Error over time per half second of footage, with the signed mean corner offset to expose bias.
const series = [];
for (let t = 0; t < duration; t += 0.5) {
  const list = inRange(t, t + 0.5);
  if (!list.length) continue;
  let dx = 0;
  let dy = 0;
  let scaleError = 0;
  for (const s of list) {
    const truthCorners = frames[s.frame].corners;
    for (let i = 0; i < 4; i++) {
      dx += (s.corners[i][0] - truthCorners[i][0]) / 4;
      dy += (s.corners[i][1] - truthCorners[i][1]) / 4;
    }
    const size = (c) => Math.hypot(c[1][0] - c[0][0], c[1][1] - c[0][1]);
    scaleError += size(s.corners) / size(truthCorners) - 1;
  }
  series.push({ t, n: list.length, px: +median(list.map(errorOf)).toFixed(2), dx: +(dx / list.length).toFixed(2), dy: +(dy / list.length).toFixed(2), scalePct: +((scaleError / list.length) * 100).toFixed(2), conf: +(list.reduce((a, s) => a + s.c, 0) / list.length).toFixed(2) });
}

const report = {
  label,
  experience: id,
  query: extraQuery,
  initMs,
  stats: {
    trackFps: +stats.trackFps.toFixed(1),
    trackMs: +stats.trackMs.toFixed(1),
    renderFps: +stats.renderFps.toFixed(0),
    input: `${stats.inputWidth}x${stats.inputHeight}`,
    confidence: +stats.confidence.toFixed(2),
  },
  posesScored: samples.length,
  posesWithoutFrameId: unmatched,
  stillAccuracy: accuracy(stillAll),
  jitter: { spreadRmsPx: +Math.sqrt(spread.reduce((a, v) => a + v * v, 0) / spread.length).toFixed(3), medianStepPx: +median(steps).toFixed(3) },
  slowMotion: accuracy(inRange(7.5, 12.5)),
  fastMotion: accuracy(inRange(13.3, 15.7)),
  afterRecovery: accuracy(inRange(19.2, 21.5)),
  posesWhilePosterGone: lostSegment.length,
  series,
  phases,
  cameraAfterClose,
  errors,
};
console.log(JSON.stringify({ ...report, series: undefined }, null, 1));
console.table(series);
writeFileSync(join(out, `report-${label}-${id}.json`), JSON.stringify(report, null, 1));
