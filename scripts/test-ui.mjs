// Drives every user-facing state in real Chrome and checks behaviour that's easy to break:
// each phase renders, hotspots select, errors offer the right recovery, the camera turns off, and
// WebGL context loss is survivable. Screenshots land in .test-output/ui-*.png.
//
//   node scripts/test-ui.mjs
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import { preview } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '.test-output');
mkdirSync(out, { recursive: true });
const truth = JSON.parse(readFileSync(join(out, 'ceat-tyre.truth.json'), 'utf8'));

const server = await preview({ root, preview: { port: 5178, strictPort: true, allowedHosts: true, host: '127.0.0.1' }, logLevel: 'error' });
const base = 'http://localhost:5178/';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const launch = (extraArgs = []) =>
  chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', ...extraArgs],
  });
const fakeCamera = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream=fps=30',
  `--use-file-for-fake-video-capture=${join(out, 'ceat-tyre.y4m')}`,
];
const phone = { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, hasTouch: true };

const phaseOf = (page) => page.evaluate(() => window.__AR__.state().phase);
const waitPhase = (page, phase, timeout = 45000) =>
  page.waitForFunction((p) => window.__AR__?.state().phase === p, phase, { timeout });
const shot = async (page, name) => {
  await page.waitForTimeout(450); // Let the screen's fade-in finish.
  await page.screenshot({ path: join(out, `ui-${name}.png`) });
};
/** Mean brightness (0-255) of a screen region, read from a real screenshot of the composited page. */
const brightnessAt = async (page, left, top, width = 60, height = 60) => {
  const png = await page.screenshot({ clip: { x: left, y: top, width, height } });
  const { channels } = await sharp(png).stats();
  return (channels[0].mean + channels[1].mean + channels[2].mean) / 3;
};
const useFootageShape = (page) =>
  page.addInitScript(([w, h]) => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = () => original({ audio: false, video: { width: { exact: w }, height: { exact: h } } });
  }, [truth.W, truth.H]);

// ---- Happy path, deep link ----
{
  const browser = await launch(fakeCamera);
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await useFootageShape(page);

  await page.goto(`${base}?t=ceat-tyre&debug&fov=64`);
  check('welcome: deep link shows brand copy', await page.getByRole('heading', { name: 'Grip that goes the extra mile' }).isVisible());
  await shot(page, 'welcome-deeplink');

  await page.getByRole('button', { name: 'Start AR' }).click();
  await waitPhase(page, 'scanning');
  check('camera + tracker start', true);
  await waitPhase(page, 'active');
  check('target detected and experience active', true);

  const hasVideo = await page.evaluate(() => [...document.querySelectorAll('video')].filter((v) => v.srcObject).length);
  check('exactly one camera stream', hasVideo === 1, `streams=${hasVideo}`);

  // The footage's wall fills the area below the poster, and it is mid grey.
  const wall = await brightnessAt(page, 170, 800);
  check('camera feed is actually on screen', wall > 100, `wall brightness ${wall.toFixed(0)}`);

  // Wait until the footage is locked-off and the hotspots are showing, then tap one.
  await page.waitForTimeout(2500);
  const target = await page.evaluate(() => {
    const runtime = window.__AR__.runtime();
    const scene = runtime.scene;
    const spots = [];
    scene.scene.traverse((node) => {
      if (node.isSprite && node.renderOrder === 40) {
        const p = node.getWorldPosition(node.position.clone()).project(scene.camera);
        spots.push({ x: (p.x + 1) * 206, y: (1 - p.y) * 457.5 });
      }
    });
    return spots;
  });
  check('three hotspot markers exist', target.length === 3, `markers=${target.length}`);
  const onScreen = target.find((s) => s.x > 10 && s.x < 402 && s.y > 80 && s.y < 840);
  if (onScreen) {
    await page.mouse.click(onScreen.x, onScreen.y);
    await page.waitForTimeout(500);
    const selected = await page.evaluate(() => window.__AR__.state().hotspot?.title ?? null);
    check('tapping a hotspot selects it', !!selected, `selected=${selected}`);
    check('hotspot card appears', await page.locator('.hotspot').isVisible());
    await page.waitForTimeout(350);
    await shot(page, 'hotspot');
    await page.mouse.click(60, 700);
    await page.waitForTimeout(300);
    check('tapping elsewhere clears it', (await page.evaluate(() => window.__AR__.state().hotspot)) === null);
  } else {
    check('hotspot on screen for tap test', false);
  }
  await shot(page, 'active');

  // Natural loss and recovery: the footage moves the poster out of frame and back.
  await waitPhase(page, 'lost', 30000);
  await shot(page, 'lost');
  check('tracking lost state', true);
  await waitPhase(page, 'recovered', 15000);
  await shot(page, 'recovered');
  check('tracking recovered state', true);
  await waitPhase(page, 'active', 5000);

  // Context loss must not leave a frozen screen.
  await page.evaluate(() => {
    const canvas = document.querySelector('canvas.ar-canvas');
    canvas.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext();
  });
  await waitPhase(page, 'error', 5000);
  const lostText = await page.locator('[role=alert] h2').innerText();
  check('WebGL context loss reaches the error screen', lostText.includes('Graphics'), lostText);
  await shot(page, 'error-webgl');
  const streamsAfterFailure = await page.evaluate(() => [...document.querySelectorAll('video')].filter((v) => v.srcObject).length);
  check('camera is off after a failure', streamsAfterFailure === 0);

  await page.getByRole('button', { name: 'Try again' }).click();
  await waitPhase(page, 'scanning');
  check('retry restarts the experience', true);
  await waitPhase(page, 'active', 30000);

  await page.getByRole('button', { name: 'Close' }).click();
  await waitPhase(page, 'welcome', 3000);
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => ({
    streams: [...document.querySelectorAll('video')].filter((v) => v.srcObject).length,
    canvases: document.querySelectorAll('canvas.ar-canvas').length,
    runtime: window.__AR__.runtime() !== null,
  }));
  check('closing stops the camera and removes the renderer', after.streams === 0 && after.canvases === 0 && !after.runtime, JSON.stringify(after));
  check('no uncaught page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
}

// ---- Preloader screens are normally too brief to inspect; hold them with slow responses ----
{
  const browser = await launch(fakeCamera);
  const page = await (await browser.newContext(phone)).newPage();
  await useFootageShape(page);
  await page.route('**/*.mind', async (route) => {
    await new Promise((r) => setTimeout(r, 1800));
    await route.continue();
  });
  await page.goto(`${base}?t=ceat-tyre&debug`);
  await page.getByRole('button', { name: 'Start AR' }).click();
  await waitPhase(page, 'initializing');
  await page.waitForTimeout(500);
  await shot(page, 'preloader');
  check('preloader state', await page.locator('.preloader').isVisible());
  await browser.close();
}

// ---- Welcome without a deep link, and multi-target recognition ----
{
  const browser = await launch(fakeCamera);
  const page = await (await browser.newContext(phone)).newPage();
  await useFootageShape(page);
  await page.goto(`${base}?debug&fov=64`);
  await shot(page, 'welcome');
  await page.getByRole('button', { name: 'Start AR' }).click();
  await waitPhase(page, 'scanning', 60000);
  await page.waitForTimeout(150);
  await shot(page, 'scanning');
  const searching = await brightnessAt(page, 170, 800);
  check('camera feed is visible while searching', searching > 100, `wall brightness ${searching.toFixed(0)}`);
  await waitPhase(page, 'active', 45000);
  const found = await page.evaluate(() => window.__AR__.state().experience?.id);
  check('all.mind picks the right poster out of five', found === 'ceat-tyre', `found=${found}`);
  await browser.close();
}

// ---- Permission denied ----
{
  const browser = await launch();
  const context = await browser.newContext({ ...phone, permissions: [] });
  const page = await context.newPage();
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
  });
  await page.goto(`${base}?debug`);
  await page.getByRole('button', { name: 'Start AR' }).click();
  await waitPhase(page, 'error', 10000);
  check('denied permission gives instructions', (await page.locator('[role=alert] h2').innerText()).includes('Camera access is off'));
  await shot(page, 'error-denied');
  await browser.close();
}

// ---- No camera ----
{
  const browser = await launch();
  const page = await (await browser.newContext(phone)).newPage();
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('none', 'NotFoundError'));
  });
  await page.goto(`${base}?debug`);
  await page.getByRole('button', { name: 'Start AR' }).click();
  await waitPhase(page, 'error', 10000);
  check('missing camera is reported', (await page.locator('[role=alert] h2').innerText()).includes('No camera'));
  await browser.close();
}

// ---- Missing target data ----
{
  const browser = await launch(fakeCamera);
  const page = await (await browser.newContext(phone)).newPage();
  await useFootageShape(page);
  await page.route('**/*.mind', (route) => route.fulfill({ status: 404, body: 'gone' }));
  await page.goto(`${base}?t=ceat-tyre&debug`);
  await page.getByRole('button', { name: 'Start AR' }).click();
  await waitPhase(page, 'error', 20000);
  check('missing tracking data is reported', (await page.locator('[role=alert] h2').innerText()).includes('tracking'));
  const streams = await page.evaluate(() => [...document.querySelectorAll('video')].filter((v) => v.srcObject).length);
  check('camera is off after an init failure', streams === 0);
  await browser.close();
}

// ---- Missing 3D model ----
{
  const browser = await launch(fakeCamera);
  const page = await (await browser.newContext(phone)).newPage();
  await useFootageShape(page);
  await page.route('**/*.glb', (route) => route.fulfill({ status: 404, body: 'gone' }));
  await page.goto(`${base}?t=ceat-tyre&debug`);
  await page.getByRole('button', { name: 'Start AR' }).click();
  await waitPhase(page, 'error', 20000);
  check('missing model is reported', (await page.locator('[role=alert] h2').innerText()).includes('Content'));
  await browser.close();
}

// ---- Unsupported browser: no camera API ----
{
  const browser = await launch();
  const page = await (await browser.newContext(phone)).newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined });
  });
  await page.goto(`${base}?debug`);
  await waitPhase(page, 'unsupported', 5000);
  await shot(page, 'unsupported');
  check('unsupported browser screen', await page.getByRole('heading', { name: /supported/ }).isVisible());
  await browser.close();
}

// ---- Insecure context: real HTTP on a non-localhost origin ----
{
  const browser = await launch(['--host-resolver-rules=MAP insecure.test 127.0.0.1']);
  const page = await (await browser.newContext(phone)).newPage();
  await page.goto('http://insecure.test:5178/?debug').catch(() => undefined);
  const phase = await page.evaluate(() => window.__AR__?.state().phase).catch(() => null);
  check('plain HTTP is flagged as unsupported', phase === 'unsupported', `phase=${phase}`);
  await browser.close();
}

await server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
