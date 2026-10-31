// Drives every user-facing state in real Chrome, with the real 8th Wall engine looking at a simulated
// camera: a drawn image of the poster, fed in through getUserMedia, with steady motion sensors. So the
// recognition and overlay alignment measured here are the engine's own, but with a perfect image. Blur,
// glare, real lenses and real movement are only covered by test-device.mjs.
// Screenshots land in .test-output/ui-*.png.
//
//   npm run build && npm run test:ui
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import { preview } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '.test-output');
mkdirSync(out, { recursive: true });

const server = await preview({ root, preview: { port: 5178, strictPort: true, allowedHosts: true, host: '127.0.0.1' }, logLevel: 'error' });
const base = 'http://localhost:5178/';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--host-resolver-rules=MAP insecure.test 127.0.0.1'] });
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; CPH2359) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const phone = { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, userAgent: ANDROID, permissions: ['camera', 'accelerometer', 'gyroscope', 'magnetometer'] };
const CAMERA = { width: 720, height: 1280 };

/** Runs in the page. Replaces the camera and motion sensors. `camera` and `motion` make them fail. */
function installSimulatedPhone({ camera = 'ok', motion = 'none', width, height }) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const sim = { image: null, scale: 0.7, x: 0, y: 0, stream: null, cameraCalls: 0, motionPrompts: 0 };
  window.__sim = sim;
  window.__showPoster = (id, options = {}) => {
    Object.assign(sim, { scale: 0.7, x: 0, y: 0 }, options);
    if (!id) {
      sim.image = null;
      return;
    }
    const image = new Image();
    image.src = `assets/experiences/${id}/target.jpg`;
    sim.image = image;
  };
  setInterval(() => {
    ctx.fillStyle = '#6b6f76';
    ctx.fillRect(0, 0, width, height);
    // A room has detail in it, which world tracking needs. A blank wall would make it give up.
    for (let i = 0; i < 80; i += 1) {
      ctx.fillStyle = i % 2 ? '#222' : '#ddd';
      ctx.fillRect((i * 97) % width, (i * 211) % height, 14, 14);
    }
    const { image, scale, x, y } = sim;
    if (image?.complete && image.naturalWidth) {
      const w = width * scale;
      const h = (w * image.naturalHeight) / image.naturalWidth;
      ctx.drawImage(image, width / 2 + x - w / 2, height / 2 + y - h / 2, w, h);
    }
  }, 33);

  navigator.mediaDevices.getUserMedia = async () => {
    sim.cameraCalls += 1;
    if (camera !== 'ok') throw new DOMException('refused by test', camera);
    sim.stream = canvas.captureStream(30);
    return sim.stream;
  };
  navigator.mediaDevices.enumerateDevices = async () => [{ kind: 'videoinput', deviceId: 'simulated', label: 'simulated', groupId: 'g' }];

  // On an iPhone, motion events come only after a prompt that must be raised by a tap.
  if (motion !== 'none') {
    const requestPermission = async () => {
      sim.motionPrompts += 1;
      sim.promptInTap = navigator.userActivation.isActive;
      return motion;
    };
    DeviceOrientationEvent.requestPermission = requestPermission;
    DeviceMotionEvent.requestPermission = requestPermission;
  }
  setInterval(() => {
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: 90, gamma: 0, absolute: false }));
    window.dispatchEvent(new DeviceMotionEvent('devicemotion', { acceleration: { x: 0, y: 0, z: 0 }, accelerationIncludingGravity: { x: 0, y: 9.8, z: 0 }, rotationRate: { alpha: 0, beta: 0, gamma: 0 }, interval: 16 }));
  }, 16);
}

const open = async (url, { sim = {}, context: contextOptions = phone } = {}) => {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(installSimulatedPhone, { ...CAMERA, ...sim });
  await page.goto(`${base}${url}`);
  return { page, errors };
};
const waitPhase = (page, phase, timeout = 20000) => page.waitForFunction((p) => window.__AR__?.state().phase === p, phase, { timeout });
const start = (page) => page.getByRole('button', { name: 'Start AR' }).click();
const alertTitle = (page) => page.locator('[role=alert] h2').innerText();
const shot = async (page, name) => {
  await page.waitForTimeout(450); // Let the screen's fade-in finish.
  await page.screenshot({ path: join(out, `ui-${name}.png`) });
};
const show = (page, id, options) => page.evaluate(([i, o]) => window.__showPoster(i, o), [id, options]);
const experience = (page) => page.evaluate(() => window.__AR__.state().experience?.id);
const phaseOf = (page) => page.evaluate(() => window.__AR__.state().phase);
const cameraOn = (page) => page.evaluate(() => window.__sim.stream?.getVideoTracks().some((track) => track.readyState === 'live') ?? false);

/**
 * Where the anchor's poster-width box lands on the screen, in CSS pixels. The camera image fills the
 * screen, cropped to fit, so this can be compared directly with where the poster was drawn.
 */
const projected = (page) =>
  page.evaluate(() => {
    const { scene } = window.__AR__.runtime();
    const { anchor, camera } = scene;
    const toScreen = (x, y) => {
      const p = anchor.position.clone().set(x, y, 0).applyMatrix4(anchor.matrix).project(camera);
      return [((p.x + 1) / 2) * innerWidth, ((1 - p.y) / 2) * innerHeight];
    };
    const [lx, ly] = toScreen(-0.5, 0);
    const [rx, ry] = toScreen(0.5, 0);
    return { width: Math.hypot(rx - lx, ry - ly), x: (lx + rx) / 2, y: (ly + ry) / 2, tilt: Math.atan2(ry - ly, rx - lx) };
  });
/** Where the simulated camera drew the poster, as the screen shows it. */
const expected = (scale, x = 0, y = 0) => {
  const fill = Math.max(phone.viewport.width / CAMERA.width, phone.viewport.height / CAMERA.height);
  return { width: CAMERA.width * scale * fill, x: phone.viewport.width / 2 + x * fill, y: phone.viewport.height / 2 + y * fill };
};
const checkAligned = async (page, name, scale, x = 0, y = 0) => {
  await page.waitForTimeout(400);
  const got = await projected(page);
  const want = expected(scale, x, y);
  const widthOff = Math.abs(got.width - want.width) / want.width;
  const offset = Math.hypot(got.x - want.x, got.y - want.y);
  check(`${name}: content lines up with the print`, widthOff < 0.03 && offset < 6 && Math.abs(got.tilt) < 0.03, `width off ${(widthOff * 100).toFixed(1)}%, centre off ${offset.toFixed(1)} px, tilt ${got.tilt.toFixed(3)}`);
};

// ---- Poster tracking, deep link ----
{
  const { page, errors } = await open('?t=ceat-tyre&debug');
  check('welcome: deep link shows brand copy', await page.getByRole('heading', { name: 'Grip that goes the extra mile' }).isVisible());
  await page.getByRole('button', { name: 'Start AR' }).waitFor({ timeout: 30000 });
  check('welcome: the engine licence is credited and linked', (await page.locator('.legal a').getAttribute('href')).endsWith('LICENSE.txt'));
  await shot(page, 'welcome-deeplink');
  check('the camera stays off until the tap', (await page.evaluate(() => window.__sim.cameraCalls)) === 0);
  await start(page);
  await waitPhase(page, 'scanning', 30000);
  check('camera is on while scanning', await cameraOn(page));
  check('scan hint shows while searching', await page.locator('.scan__hint').isVisible());
  await shot(page, 'scanning');

  const t0 = Date.now();
  await show(page, 'ceat-tyre');
  await waitPhase(page, 'active', 10000);
  check('the engine recognises the poster', true, `${Date.now() - t0} ms`);
  await checkAligned(page, 'ceat-tyre', 0.7);

  await page.waitForTimeout(1800); // The intro finishes, and hotspots show.
  await shot(page, 'active');
  const png = await page.screenshot({ clip: { x: 106, y: 300, width: 200, height: 300 } });
  const { channels } = await sharp(png).stats();
  check('tyre is drawn where the poster is', channels[0].stdev + channels[1].stdev > 10, `stdev ${channels[0].stdev.toFixed(0)}`);
  const feed = await sharp(await page.screenshot({ clip: { x: 0, y: 200, width: 412, height: 100 } })).stats();
  check('the camera image is drawn behind the content', feed.channels[0].stdev > 5, `detail stdev ${feed.channels[0].stdev.toFixed(0)}`);

  // Tap the marker on screen, the same way a finger would.
  const point = await page.evaluate(() => {
    const { scene } = window.__AR__.runtime();
    const markers = [];
    scene.scene.traverse((node) => {
      if (node.isSprite && node.renderOrder === 40) markers.push(node);
    });
    const p = markers[0].getWorldPosition(markers[0].position.clone()).project(scene.camera);
    return [((p.x + 1) / 2) * innerWidth, ((1 - p.y) / 2) * innerHeight];
  });
  await page.mouse.click(point[0], point[1]);
  await page.waitForTimeout(150);
  const picked = await page.evaluate(() => window.__AR__.state().hotspot?.title ?? null);
  check('tapping a hotspot selects it', !!picked, `selected=${picked}`);
  check('hotspot card appears', await page.locator('.hotspot').isVisible());
  await shot(page, 'hotspot');

  // Look away: world tracking is holding its place, so nothing should change.
  await show(page, null);
  await page.waitForTimeout(1200);
  check('stays locked while the poster is out of view', (await phaseOf(page)) === 'active');
  check('debug stats report the held poster', (await page.evaluate(() => window.__AR__.stats().imageState)) === 'held');
  await shot(page, 'held');

  // Force what happens if the engine loses track of the room as well. A static simulation can't make it.
  await page.evaluate(() => {
    window.__AR__.runtime().tracking.adapter.status = 'LIMITED';
    const { onFrame } = window.__AR__.runtime().tracking.adapter;
    window.__AR__.runtime().tracking.adapter.onFrame = function (reality) {
      onFrame.call(this, { ...reality, trackingStatus: 'LIMITED' });
    };
  });
  await waitPhase(page, 'lost', 3000);
  await shot(page, 'lost');
  check('losing the room shows the lost state', await page.locator('.scan__hint').isVisible());
  await show(page, 'ceat-tyre');
  await waitPhase(page, 'recovered', 5000);
  check('the poster coming back is recovered immediately', true);
  await shot(page, 'recovered');
  await waitPhase(page, 'active', 5000);

  await page.evaluate(() => document.querySelector('canvas.ar-canvas').getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
  await waitPhase(page, 'error', 5000);
  check('WebGL context loss reaches the error screen', (await alertTitle(page)).includes('Graphics'));
  check('camera is off after a failure', !(await cameraOn(page)));
  await show(page, null); // Otherwise it can lock so fast that scanning never shows.
  await page.getByRole('button', { name: 'Try again' }).click();
  await waitPhase(page, 'scanning', 30000);
  check('retry starts the camera again', await cameraOn(page));
  await page.getByRole('button', { name: 'Close' }).click();
  await waitPhase(page, 'welcome', 3000);
  const after = await page.evaluate(() => ({ canvases: document.querySelectorAll('canvas.ar-canvas').length, runtime: window.__AR__.runtime() !== null }));
  check('closing removes the renderer', after.canvases === 0 && !after.runtime, JSON.stringify(after));
  check('closing turns the camera off', !(await cameraOn(page)));
  await start(page);
  await waitPhase(page, 'scanning', 30000);
  await show(page, 'ceat-tyre');
  await waitPhase(page, 'active', 10000);
  check('a session started after closing tracks again', true);
  check('no uncaught page errors', errors.length === 0, errors.join(' | '));
  await page.context().close();
}

// ---- All five posters, each with the engine's own recognition ----
{
  const { page, errors } = await open('?debug');
  await shot(page, 'welcome');
  await page.getByRole('button', { name: 'Start AR' }).waitFor({ timeout: 30000 });
  await shot(page, 'welcome-ready');
  await start(page);
  await waitPhase(page, 'scanning', 30000);

  for (const id of ['flower', 'basketball', 'jelly', 'love', 'ceat-tyre']) {
    const t0 = Date.now();
    await show(page, id);
    await page.waitForFunction((i) => window.__AR__.state().experience?.id === i, id, { timeout: 15000 });
    await waitPhase(page, 'active', 20000);
    check(`${id}: recognised and shown`, true, `${Date.now() - t0} ms`);
    await checkAligned(page, id, 0.7);
    await page.waitForTimeout(600);
    await shot(page, `poster-${id}`);
    await show(page, null);
    await page.waitForTimeout(500);
  }

  // A poster off to one side and further away, so errors in the projection or the lens show up.
  await show(page, 'jelly', { scale: 0.45, x: 90, y: -160 });
  await page.waitForFunction(() => window.__AR__.state().experience?.id === 'jelly', null, { timeout: 15000 });
  await waitPhase(page, 'active', 20000);
  await checkAligned(page, 'off-centre poster', 0.45, 90, -160);

  const before = await experience(page);
  await page.waitForTimeout(500);
  check('the shown poster does not flip with nothing new in view', (await experience(page)) === before);
  const fps = await page.evaluate(() => window.__AR__.stats().trackFps);
  check('the engine is producing frames', fps > 5, `${fps.toFixed(0)} fps on this machine's GPU`);
  check('no uncaught page errors (five posters)', errors.length === 0, errors.join(' | '));
  await page.context().close();
}

// ---- Room placement ----
{
  const { page, errors } = await open('?t=ceat-tyre&debug');
  await page.getByRole('button', { name: /Place the tyre/ }).click();
  await waitPhase(page, 'scanning', 30000);
  await shot(page, 'placement-searching');

  // A level camera never meets the floor, so point it down.
  await page.evaluate(() => {
    const { adapter } = window.__AR__.runtime().tracking;
    const { onFrame } = adapter;
    adapter.onFrame = function (reality) {
      onFrame.call(this, { ...reality, rotation: { x: -Math.SQRT1_2 / 1.3, y: 0, z: 0, w: Math.sqrt(1 - 1 / (2 * 1.69)) } });
    };
  });
  await page.waitForFunction(() => window.__AR__.state().placement === 'ready', null, { timeout: 5000 });
  await shot(page, 'placement-ready');
  await page.mouse.click(206, 500);
  await waitPhase(page, 'active', 5000);
  check('tapping places the tyre', (await page.evaluate(() => window.__AR__.state().placement)) === 'placed');
  await page.waitForTimeout(2000);
  await shot(page, 'placement-placed');
  const floor = await page.evaluate(() => window.__AR__.runtime().scene.anchor.matrix.elements[13]);
  check('placed content sits near the floor', Math.abs(floor) < 1, `content y ${floor.toFixed(2)}`);
  check('no uncaught page errors (placement)', errors.length === 0, errors.join(' | '));
  await page.context().close();
}

// ---- Permission and camera failures ----
for (const [camera, title, name] of [
  ['NotAllowedError', 'Camera access is off', 'denied camera gives instructions'],
  ['NotReadableError', 'Couldn’t start the camera', 'a camera in use is reported'],
]) {
  const { page } = await open('?t=ceat-tyre&debug', { sim: { camera } });
  await page.getByRole('button', { name: 'Start AR' }).waitFor({ timeout: 30000 });
  await start(page);
  await waitPhase(page, 'error', 15000);
  const got = await alertTitle(page);
  check(name, got.includes(title), got);
  await shot(page, `error-${camera}`);
  await page.context().close();
}

// ---- iPhone: the engine accepts it, and motion is asked for inside the tap ----
{
  const { page, errors } = await open('?t=ceat-tyre&debug', { sim: { motion: 'granted' }, context: { ...phone, userAgent: IPHONE } });
  await page.getByRole('button', { name: 'Start AR' }).waitFor({ timeout: 30000 });
  check('iPhone is accepted, not turned away', (await phaseOf(page)) === 'welcome');
  await start(page);
  await waitPhase(page, 'scanning', 30000);
  const asked = await page.evaluate(() => ({ prompts: window.__sim.motionPrompts, inTap: window.__sim.promptInTap }));
  check('iPhone motion prompt is raised inside the tap', asked.prompts > 0 && asked.inTap, JSON.stringify(asked));
  await show(page, 'ceat-tyre');
  await waitPhase(page, 'active', 15000);
  check('iPhone user agent: poster tracks', true);
  check('no uncaught page errors (iPhone)', errors.length === 0, errors.join(' | '));
  await page.context().close();
}
{
  const { page } = await open('?t=ceat-tyre&debug', { sim: { motion: 'denied' }, context: { ...phone, userAgent: IPHONE } });
  await page.getByRole('button', { name: 'Start AR' }).waitFor({ timeout: 30000 });
  await start(page);
  await waitPhase(page, 'error', 5000);
  check('denied motion on iPhone gives instructions', (await alertTitle(page)).includes('Motion'));
  check('the camera stays off when motion is denied', (await page.evaluate(() => window.__sim.cameraCalls)) === 0);
  await shot(page, 'error-motion');
  await page.context().close();
}

// ---- Missing assets ----
{
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  await page.addInitScript(installSimulatedPhone, CAMERA);
  await page.route('**/*.glb', (route) => route.fulfill({ status: 404, body: 'gone' }));
  await page.goto(`${base}?t=ceat-tyre&debug`);
  await page.getByRole('button', { name: 'Start AR' }).waitFor({ timeout: 30000 });
  await start(page);
  await waitPhase(page, 'error', 30000);
  check('missing model is reported', (await alertTitle(page)).includes('Content'));
  check('camera is off after a content failure', !(await cameraOn(page)));
  await context.close();
}
{
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  await page.addInitScript(installSimulatedPhone, CAMERA);
  await page.route('**/targets/*.json', (route) => route.fulfill({ status: 404, body: 'gone' }));
  await page.goto(`${base}?t=ceat-tyre&debug`);
  await waitPhase(page, 'error', 30000);
  check('missing poster data is reported', (await alertTitle(page)).includes('Content'));
  await page.unroute('**/targets/*.json');
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.getByRole('button', { name: 'Start AR' }).waitFor({ timeout: 30000 });
  check('retry reloads the poster data', true);
  await context.close();
}

// ---- Devices that can't run it: these use the engine's and browser's real answers ----
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${base}?debug`);
  await waitPhase(page, 'unsupported', 30000);
  await shot(page, 'unsupported');
  check('desktop is told to use a phone', (await page.locator('[role=alert] p').innerText()).includes('phone'));
  await context.close();
}
{
  const page = await (await browser.newContext(phone)).newPage();
  await page.goto('http://insecure.test:5178/?debug').catch(() => undefined);
  const phase = await page.evaluate(() => window.__AR__?.state().phase).catch(() => null);
  check('plain HTTP is flagged as unsupported', phase === 'unsupported', `phase=${phase}`);
  await page.context().close();
}

await browser.close();
await server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
