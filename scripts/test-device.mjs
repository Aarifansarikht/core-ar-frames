// Tests on a real Android phone attached over USB, using `adb reverse` so that http://localhost is a
// secure context on the device. Reports what the phone actually grants and how the tracker performs
// on its GPU.
//
//   npm run build && npm run test:device            (needs USB debugging enabled and Chrome installed)
//
// Part 1 probes WebXR. Part 2 runs the real app and tracker with generated footage replacing the
// camera, injected from this script only, so timing and accuracy are measured without the phone needing
// to be pointed at a poster. Part 3 starts the app with the phone's real camera. Part 4 starts an
// immersive WebXR session. Keep the phone unlocked and awake throughout.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import { adb, connectPhoneChrome, reversePort } from './lib-device.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '.test-output');
mkdirSync(out, { recursive: true });
const PORT = 5180;

// A phone-friendly copy of the footage. H.264 decodes in hardware on the device.
const footageMp4 = join(root, 'dist', '__footage.mp4');
const y4m = join(out, 'ceat-tyre.y4m');
if (!existsSync(footageMp4)) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', y4m, '-c:v', 'libx264', '-profile:v', 'high', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', footageMp4]);
}
const truth = JSON.parse(readFileSync(join(out, 'ceat-tyre.truth.json'), 'utf8'));

const server = await preview({ root, preview: { port: PORT, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' });
reversePort(PORT);
const { browser, context } = await connectPhoneChrome();
const report = {
  model: adb('shell', 'getprop', 'ro.product.model'),
  android: adb('shell', 'getprop', 'ro.build.version.release'),
};

const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://localhost:${PORT}/?t=ceat-tyre&debug`);
const cdp = await context.newCDPSession(page);
await cdp.send('Browser.grantPermissions', { permissions: ['videoCapture'], origin: `http://localhost:${PORT}` }).catch(() => undefined);

const evalGesture = async (expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) return { threw: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
  return r.result.value;
};

// ---- Part 1: what does this phone actually grant? ----
report.env = await evalGesture(`({ua:navigator.userAgent,memory:navigator.deviceMemory,cores:navigator.hardwareConcurrency,dpr:devicePixelRatio,secure:isSecureContext})`);
report.immersiveAR = await evalGesture(`navigator.xr ? navigator.xr.isSessionSupported('immersive-ar') : false`);
report.features = {};
if (report.immersiveAR === true) {
  for (const feature of ['hit-test', 'anchors', 'dom-overlay', 'light-estimation', 'camera-access', 'image-tracking']) {
    const extras =
      feature === 'dom-overlay'
        ? `domOverlay:{root:document.body},`
        : feature === 'image-tracking'
          ? `trackedImages:[{image:await createImageBitmap(Object.assign(document.createElement('canvas'),{width:256,height:256})),widthInMeters:0.5}],`
          : '';
    report.features[feature] = await evalGesture(`(async()=>{try{const s=await navigator.xr.requestSession('immersive-ar',{${extras}optionalFeatures:['${feature}']});const e=[...(s.enabledFeatures||[])];await s.end();return e.includes('${feature}');}catch(err){return String(err)}})()`);
    await page.waitForTimeout(1200);
  }
}
console.log(JSON.stringify(report, null, 1));

// ---- Part 2: tracker on the phone's GPU, against footage with a known path ----
await page.addInitScript(() => {
  // Test-only camera replacement: a looping <video> exposed as a MediaStream.
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  window.__realGetUserMedia = original;
  navigator.mediaDevices.getUserMedia = async () => {
    const video = document.createElement('video');
    video.src = '/__footage.mp4';
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    window.__testVideo = video;
    return video.captureStream();
  };
});
await page.goto(`http://localhost:${PORT}/?t=ceat-tyre&debug&fov=${truth.fovLong}`);
await page.getByRole('button', { name: 'Start AR' }).tap();
const started = Date.now();
await page.waitForFunction(() => window.__AR__?.state().phase === 'scanning', null, { timeout: 120000 });
report.trackerInitMs = Date.now() - started;

const samples = [];
const t0 = Date.now();
const seen = new Set();
let shots = 0;
while (Date.now() - t0 < 32000) {
  const s = await page.evaluate(() => ({ phase: window.__AR__.state().phase, stats: window.__AR__.stats() }));
  if (s.stats) samples.push(s.stats);
  seen.add(s.phase);
  if (s.phase === 'active' && shots < 2 && Date.now() - t0 > 6000 + shots * 4000) {
    await page.screenshot({ path: join(out, `device-active-${shots++}.png`) });
  }
  await page.waitForTimeout(500);
}
const mean = (key) => samples.reduce((a, s) => a + s[key], 0) / Math.max(samples.length, 1);
const heap = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
report.tracking = {
  phasesSeen: [...seen],
  trackFps: +mean('trackFps').toFixed(1),
  trackMs: +mean('trackMs').toFixed(1),
  renderFps: +mean('renderFps').toFixed(1),
  input: samples.at(-1) ? `${samples.at(-1).inputWidth}x${samples.at(-1).inputHeight}` : null,
  jsHeapMB: heap ? +(heap / 1048576).toFixed(0) : null,
};

// ---- Part 3: the phone's real camera ----
await page.evaluate(() => {
  navigator.mediaDevices.getUserMedia = window.__realGetUserMedia;
  window.__testVideo?.pause();
});
await page.getByRole('button', { name: 'Close' }).tap();
await page.waitForFunction(() => window.__AR__.state().phase === 'welcome', null, { timeout: 8000 });
await page.getByRole('button', { name: 'Start AR' }).tap();
await page.waitForFunction(() => ['scanning', 'error'].includes(window.__AR__.state().phase), null, { timeout: 60000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: join(out, 'device-camera.png') });
report.realCamera = await page.evaluate(() => {
  const video = [...document.querySelectorAll('video')].find((v) => v.srcObject);
  return {
    phase: window.__AR__.state().phase,
    error: window.__AR__.state().error?.title ?? null,
    size: video ? `${video.videoWidth}x${video.videoHeight}` : null,
    stats: window.__AR__.stats(),
  };
});
await page.getByRole('button', { name: 'Close' }).tap().catch(() => undefined);
await page.waitForTimeout(800);
report.cameraOffAfterClose = await page.evaluate(() => [...document.querySelectorAll('video')].filter((v) => v.srcObject).length === 0);

// ---- Part 4: immersive WebXR. Hit testing needs the camera to see a textured surface. ----
if (report.immersiveAR === true) {
  await page.waitForFunction(() => window.__AR__.state().phase === 'welcome', null, { timeout: 8000 }).catch(() => undefined);
  await evalGesture(`document.querySelector('button.button--ghost')?.click()`);
  const placement = [];
  const started4 = Date.now();
  while (Date.now() - started4 < 15000) {
    const s = await page.evaluate(() => {
      const st = window.__AR__.state();
      return `${st.phase}/${st.placement}${st.error ? '/' + st.error.title : ''}`;
    });
    if (placement.at(-1) !== s) placement.push(s);
    await page.waitForTimeout(400);
  }
  report.webxrSession = { states: placement, stats: await page.evaluate(() => window.__AR__.stats()) };
  await page.evaluate(() => window.__AR__.runtime()?.scene?.renderer.xr.getSession()?.end()).catch(() => undefined);
}

report.errors = errors;

console.log(JSON.stringify(report, null, 1));
writeFileSync(join(out, 'report-device.json'), JSON.stringify(report, null, 1));

await page.close();
await browser.close();
await server.close();
adb('reverse', '--remove', `tcp:${PORT}`);
process.exit(0);
