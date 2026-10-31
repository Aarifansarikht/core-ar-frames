// Drives every user-facing state in real Chrome. ARCore can't run on a desktop, so most cases use a
// scripted stand-in for navigator.xr. The recogniser in the last section is the real one, looking at a
// drawn camera image with a known camera path. Nothing here measures ARCore itself or a real camera:
// only test-device.mjs can do that.
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
const phone = { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, hasTouch: true };

/** Runs in the page. `reject` makes requestSession fail with that DOMException name. */
function installFakeXR({ reject = null, grant = ['image-tracking', 'dom-overlay'] }) {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const near = 0.02;
  const far = 60;
  const f = 1 / Math.tan((60 * Math.PI) / 360);
  const aspect = innerWidth / innerHeight;
  const projection = new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, -(far + near) / (far - near), -1, 0, 0, (-2 * far * near) / (far - near), 0]);
  const transform = (matrix) => ({
    matrix: new Float32Array(matrix),
    position: { x: matrix[12], y: matrix[13], z: matrix[14], w: 1 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
  });
  const space = (matrix = identity) => ({ matrix, getOffsetReferenceSpace() { return this; }, addEventListener() {}, removeEventListener() {} });

  const fake = { requests: [], session: null, results: [], hits: [], ended: 0, space, lastFrame: null };
  window.__fakeXR = fake;

  const frame = (session) => ({
    session,
    getViewerPose: () => ({ transform: transform(identity), views: [{ eye: 'none', projectionMatrix: projection, transform: transform(identity) }] }),
    getPose: (s) => ({ transform: transform(s.matrix) }),
    getImageTrackingResults: () => fake.results,
    getHitTestResults: () => fake.hits.map((matrix) => ({ getPose: () => ({ transform: transform(matrix) }) })),
    getLightEstimate: () => null,
  });

  class FakeSession extends EventTarget {
    renderState = {};
    inputSources = [];
    environmentBlendMode = 'alpha-blend';
    visibilityState = 'visible';
    constructor(init) {
      super();
      this.enabledFeatures = [...(init.requiredFeatures ?? []), ...(init.optionalFeatures ?? []).filter((f) => grant.includes(f))];
    }
    updateRenderState(state) { Object.assign(this.renderState, state); }
    updateTargetFrameRate() { return Promise.resolve(); }
    async requestReferenceSpace() { return space(); }
    async requestHitTestSource() { return { cancel() {} }; }
    async getTrackedImageScores() { return fake.requests.at(-1).trackedImages.map(() => 'trackable'); }
    requestAnimationFrame(callback) {
      return requestAnimationFrame((t) => {
        fake.lastFrame = frame(this);
        callback(t, fake.lastFrame);
      });
    }
    cancelAnimationFrame(id) { cancelAnimationFrame(id); }
    async end() {
      if (fake.session !== this) return;
      fake.session = null;
      fake.ended += 1;
      this.dispatchEvent(new Event('end'));
    }
  }

  // three.js creates these for the session it is given, and real ones reject a stand-in.
  Object.defineProperty(window, 'XRWebGLBinding', { value: undefined, configurable: true });
  window.XRWebGLLayer = class {
    framebuffer = null;
    antialias = false;
    ignoreDepthValues = true;
    constructor(_session, gl) {
      this.framebufferWidth = gl.drawingBufferWidth;
      this.framebufferHeight = gl.drawingBufferHeight;
    }
    getViewport() { return { x: 0, y: 0, width: this.framebufferWidth, height: this.framebufferHeight }; }
  };
  WebGL2RenderingContext.prototype.makeXRCompatible = async () => undefined;

  Object.defineProperty(navigator, 'xr', {
    configurable: true,
    value: Object.assign(new EventTarget(), {
      isSessionSupported: async () => true,
      requestSession: (mode, init) => {
        fake.requests.push({ ...init, mode, activated: navigator.userActivation.isActive });
        if (reject) return Promise.reject(new DOMException('rejected by test', reject));
        fake.session = new FakeSession(init);
        return Promise.resolve(fake.session);
      },
    }),
  });
}

/** A poster 0.8 m ahead, squarely facing the camera, in ARCore's frame: +Y out of the image, +Z down. */
const POSTER_POSE = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, -0.8, 1];
const setResults = (page, list) =>
  page.evaluate(([entries, pose]) => {
    const fake = window.__fakeXR;
    fake.results = entries.map(({ index, trackingState, width = 0.5 }) => ({ index, trackingState, measuredWidthInMeters: width, imageSpace: fake.space(pose) }));
  }, [list, POSTER_POSE]);

const open = async (url, fakeOptions) => {
  const page = await (await browser.newContext(phone)).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (fakeOptions) await page.addInitScript(installFakeXR, fakeOptions);
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
const sessionOpen = (page) => page.evaluate(() => window.__fakeXR.session !== null);
const anchor = (page) => page.evaluate(() => Array.from(window.__AR__.runtime().scene.anchor.matrix.elements));
const near = (a, b) => Math.abs(a - b) < 1e-4;

// ---- Poster tracking, deep link ----
{
  const { page, errors } = await open('?t=ceat-tyre&debug&w=0.42', {});
  check('welcome: deep link shows brand copy', await page.getByRole('heading', { name: 'Grip that goes the extra mile' }).isVisible());
  await page.getByRole('button', { name: 'Start AR' }).waitFor({ timeout: 10000 });
  await shot(page, 'welcome-deeplink');
  await start(page);
  await waitPhase(page, 'scanning');

  const request = await page.evaluate(() => {
    const r = window.__fakeXR.requests[0];
    return { required: r.requiredFeatures, optional: r.optionalFeatures, images: r.trackedImages.length, width: r.trackedImages[0].widthInMeters, bitmapWidth: r.trackedImages[0].image.width, activated: r.activated };
  });
  check('nothing the flag controls is required', !(request.required ?? []).includes('image-tracking'));
  check('session is requested inside the tap', request.activated);
  check('deep link registers one poster at the given print width', request.images === 1 && request.width === 0.42 && request.bitmapWidth === 1024, JSON.stringify(request));
  check('no MediaStream camera is opened', (await page.evaluate(() => document.querySelectorAll('video').length)) === 0 || (await page.evaluate(() => [...document.querySelectorAll('video')].every((v) => !v.srcObject))));
  check('scan hint shows while searching', await page.locator('.scan__hint').isVisible());
  await shot(page, 'scanning');

  await setResults(page, [{ index: 0, trackingState: 'tracked' }]);
  await waitPhase(page, 'active', 3000);
  check('content appears on the first ARCore pose', true);
  await page.waitForTimeout(300);
  const m = await anchor(page);
  // ARCore's +Y out, +Z down has to become the content frame's +Z out, +Y up, sized by measured width.
  const faces = near(m[0], 0.5) && near(m[5], 0.5) && near(m[10], 0.5) && near(m[9], 0) && near(m[6], 0) && near(m[14], -0.8);
  check('image pose converts to the content frame at measured width', faces, m.map((v) => +v.toFixed(3)).join(','));

  await page.waitForTimeout(1800); // The intro finishes, and hotspots show.
  await shot(page, 'active');
  const png = await page.screenshot({ clip: { x: 206, y: 300, width: 200, height: 300 } });
  const { channels } = await sharp(png).stats();
  check('tyre is drawn where the poster is', channels[0].stdev + channels[1].stdev > 10, `stdev ${channels[0].stdev.toFixed(0)}`);

  // Look away: ARCore goes on reporting the poster's remembered place. Nothing should change.
  await setResults(page, [{ index: 0, trackingState: 'emulated' }]);
  await page.waitForTimeout(900);
  check('stays locked while the poster is out of view', (await page.evaluate(() => window.__AR__.state().phase)) === 'active');
  await setResults(page, [{ index: 0, trackingState: 'tracked' }]);
  await page.waitForTimeout(150);
  check('no lost or recovered flash on looking back', (await page.evaluate(() => window.__AR__.state().phase)) === 'active');

  // Tap a hotspot through the XR select event, which is how taps arrive during a session.
  const picked = await page.evaluate(() => {
    const runtime = window.__AR__.runtime();
    const marker = [];
    runtime.scene.scene.traverse((node) => {
      if (node.isSprite && node.renderOrder === 40) marker.push(node);
    });
    const world = marker[0].getWorldPosition(marker[0].position.clone());
    const dir = world.clone().normalize();
    // A camera-origin ray through the marker: rotate -Z onto dir, with the fake using a pose lookup.
    const fake = window.__fakeXR;
    const event = new Event('select');
    const q = { x: dir.y, y: -dir.x, z: 0, w: 1 - dir.z };
    const norm = Math.hypot(q.x, q.y, q.z, q.w);
    event.frame = { getPose: () => ({ transform: { position: { x: 0, y: 0, z: 0 }, orientation: { x: q.x / norm, y: q.y / norm, z: q.z / norm, w: q.w / norm } } }) };
    event.inputSource = { targetRaySpace: fake.space() };
    fake.session.dispatchEvent(event);
    return window.__AR__.state().hotspot?.title ?? null;
  });
  check('tapping a hotspot selects it', !!picked, `selected=${picked}`);
  await page.waitForTimeout(100);
  check('hotspot card appears', await page.locator('.hotspot').isVisible());
  await shot(page, 'hotspot');

  // ARCore stops reporting it entirely: lost, then recovered at once when it returns.
  await setResults(page, [{ index: 0, trackingState: 'untracked' }]);
  await waitPhase(page, 'lost', 3000);
  await shot(page, 'lost');
  check('losing the poster shows the lost state', await page.locator('.scan__hint').isVisible());
  await setResults(page, [{ index: 0, trackingState: 'tracked' }]);
  await waitPhase(page, 'recovered', 1000);
  await shot(page, 'recovered');
  check('coming back is recognised immediately', true);
  await waitPhase(page, 'active', 5000);

  await page.evaluate(() => document.querySelector('canvas.ar-canvas').getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
  await waitPhase(page, 'error', 5000);
  check('WebGL context loss reaches the error screen', (await alertTitle(page)).includes('Graphics'));
  check('session and camera are off after a failure', !(await sessionOpen(page)));
  await page.getByRole('button', { name: 'Try again' }).click();
  await waitPhase(page, 'scanning');
  check('retry starts a new session', await sessionOpen(page));

  await page.getByRole('button', { name: 'Close' }).click();
  await waitPhase(page, 'welcome', 3000);
  const after = await page.evaluate(() => ({ open: window.__fakeXR.session !== null, canvases: document.querySelectorAll('canvas.ar-canvas').length, runtime: window.__AR__.runtime() !== null }));
  check('closing ends the session and removes the renderer', !after.open && after.canvases === 0 && !after.runtime, JSON.stringify(after));

  await start(page);
  await waitPhase(page, 'scanning');
  await page.evaluate(() => window.__fakeXR.session.end());
  await waitPhase(page, 'welcome', 3000);
  check('leaving AR with the system back gesture returns to welcome', (await page.locator('canvas.ar-canvas').count()) === 0);
  check('no uncaught page errors', errors.length === 0, errors.join(' | '));
  await page.context().close();
}

// ---- All five posters ----
{
  const { page, errors } = await open('?debug', {});
  await shot(page, 'welcome');
  await page.getByRole('button', { name: 'Start AR' }).waitFor({ timeout: 15000 });
  await start(page);
  await waitPhase(page, 'scanning');
  check('registers all five posters', (await page.evaluate(() => window.__fakeXR.requests[0].trackedImages.length)) === 5);

  await setResults(page, [{ index: 2, trackingState: 'tracked' }]);
  await page.waitForFunction(() => window.__AR__.state().experience?.id === 'flower', null, { timeout: 3000 });
  check('ARCore index picks the right poster', true);
  await waitPhase(page, 'active', 15000);

  await setResults(page, [{ index: 2, trackingState: 'emulated' }, { index: 0, trackingState: 'emulated' }]);
  await page.waitForTimeout(400);
  check('a remembered poster does not steal the view', (await page.evaluate(() => window.__AR__.state().experience?.id)) === 'flower');

  await setResults(page, [{ index: 2, trackingState: 'emulated' }, { index: 3, trackingState: 'tracked' }]);
  await page.waitForFunction(() => window.__AR__.state().experience?.id === 'jelly', null, { timeout: 3000 });
  check('a poster in view takes over from a remembered one', true);
  check('no uncaught page errors (five posters)', errors.length === 0, errors.join(' | '));
  await page.context().close();
}

// ---- Room placement ----
{
  const { page, errors } = await open('?t=ceat-tyre&debug', {});
  await page.getByRole('button', { name: /Place the tyre/ }).click();
  await waitPhase(page, 'scanning');
  check('room placement asks for hit testing', await page.evaluate(() => window.__fakeXR.requests[0].requiredFeatures.includes('hit-test')));
  await page.evaluate(() => {
    window.__fakeXR.hits = [[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, -1.5, 1]];
  });
  await page.waitForFunction(() => window.__AR__.state().placement === 'ready', null, { timeout: 3000 });
  await page.evaluate(() => {
    const fake = window.__fakeXR;
    const event = new Event('select');
    event.frame = fake.lastFrame;
    event.inputSource = { targetRaySpace: fake.space() };
    fake.session.dispatchEvent(event);
  });
  await waitPhase(page, 'active', 3000);
  check('tapping places the tyre', (await page.evaluate(() => window.__AR__.state().placement)) === 'placed');
  check('no uncaught page errors (placement)', errors.length === 0, errors.join(' | '));
  await page.context().close();
}

// ---- Session request failures ----
for (const [reject, title, name] of [
  ['NotSupportedError', 'Couldn’t start ARCore', 'ARCore missing is reported, with no mention of flags'],
  ['NotAllowedError', 'Camera access is off', 'denied permission gives instructions'],
  ['OperationError', 'Couldn’t start ARCore', 'other session failures are reported'],
]) {
  const { page } = await open('?t=ceat-tyre&debug', { reject });
  await page.getByRole('button', { name: 'Start AR' }).waitFor({ timeout: 10000 });
  await start(page);
  await waitPhase(page, 'error', 5000);
  check(name, (await alertTitle(page)).includes(title));
  await shot(page, `error-${reject}`);
  await page.context().close();
}

// ---- Missing assets ----
{
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  await page.addInitScript(installFakeXR, {});
  await page.route('**/*.glb', (route) => route.fulfill({ status: 404, body: 'gone' }));
  await page.goto(`${base}?t=ceat-tyre&debug`);
  await page.getByRole('button', { name: 'Start AR' }).waitFor({ timeout: 10000 });
  await start(page);
  await waitPhase(page, 'error', 10000);
  check('missing model is reported', (await alertTitle(page)).includes('Content'));
  check('session ends after a content failure', !(await sessionOpen(page)));
  await context.close();
}
{
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  await page.addInitScript(installFakeXR, {});
  await page.route('**/target.jpg', (route) => route.fulfill({ status: 404, body: 'gone' }));
  await page.goto(`${base}?t=ceat-tyre&debug`);
  await waitPhase(page, 'error', 10000);
  check('missing poster image is reported', (await alertTitle(page)).includes('Content'));
  await page.unroute('**/target.jpg');
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.getByRole('button', { name: 'Start AR' }).waitFor({ timeout: 10000 });
  check('retry reloads the poster images', true);
  await context.close();
}

// ---- No flag: the real recogniser in its worker, on a drawn camera image with a known camera path ----
for (const flipped of [false, true]) {
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.addInitScript(installFakeXR, { grant: ['camera-access', 'dom-overlay'] });
  await page.addInitScript(([targets, upsideDown]) => {
    // A poster on a wall, 0.8 m in front of the path's start, and 0.4 m wide. The app assumes 0.6 m.
    const W = 540;
    const H = 1200;
    const f = (H / 2) / Math.tan((60 * Math.PI) / 360);
    const images = targets.map((url) => {
      const image = new Image();
      image.src = url;
      return image;
    });
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const sim = { poster: 0, camera: [0, 0, 0], visible: true, width: 0.4, distance: 0.8, frames: 0 };
    window.__sim = sim;
    const textures = new WeakMap();
    window.XRWebGLBindingFake = class {
      constructor(_s, gl) { this.gl = gl; }
      getCameraImage() {
        const { gl } = this;
        const image = images[sim.poster];
        ctx.fillStyle = '#6b6f76';
        ctx.fillRect(0, 0, W, H);
        if (sim.visible && image.complete && image.naturalWidth) {
          const d = sim.distance - sim.camera[2] * -1;
          const px = (sim.width * f) / d;
          const py = (px * image.naturalHeight) / image.naturalWidth;
          const cx = W / 2 - (sim.camera[0] * f) / d;
          const cy = H / 2 + (sim.camera[1] * f) / d;
          ctx.drawImage(image, cx - px / 2, cy - py / 2, px, py);
        }
        let texture = textures.get(gl);
        if (!texture) {
          texture = gl.createTexture();
          textures.set(gl, texture);
        }
        const previous = gl.getParameter(gl.TEXTURE_BINDING_2D);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, upsideDown);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.bindTexture(gl.TEXTURE_2D, previous);
        sim.frames += 1;
        return texture;
      }
    };
    Object.defineProperty(window, 'XRWebGLBinding', { value: window.XRWebGLBindingFake, configurable: true });
  }, [['assets/experiences/ceat-tyre/target.jpg', 'assets/experiences/basketball/target.jpg', 'assets/experiences/flower/target.jpg', 'assets/experiences/jelly/target.jpg', 'assets/experiences/love/target.jpg'].map((p) => base + p), flipped]);
  await page.addInitScript(() => {
    // The stand-in's camera view: a camera the simulation moves, matching the drawn image's lens.
    const original = navigator.xr.requestSession;
    navigator.xr.requestSession = async (mode, init) => {
      const session = await original(mode, init);
      const raf = session.requestAnimationFrame.bind(session);
      session.requestAnimationFrame = (callback) =>
        raf((t, frame) => {
          const getViewerPose = frame.getViewerPose;
          frame.getViewerPose = (space) => {
            const pose = getViewerPose(space);
            const [x, y, z] = window.__sim.camera;
            const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
            const transform = { matrix: new Float32Array(m), position: { x, y, z, w: 1 }, orientation: { x: 0, y: 0, z: 0, w: 1 } };
            const p = new Float32Array(pose.views[0].projectionMatrix);
            p[0] = p[5] * (1200 / 540);
            return { transform, views: [{ eye: 'none', projectionMatrix: p, transform, camera: { width: 540, height: 1200 } }] };
          };
          callback(t, frame);
        });
      return session;
    };
  });
  await page.goto(`${base}?debug`);
  await page.getByRole('button', { name: 'Start AR' }).waitFor({ timeout: 15000 });
  await start(page);
  await waitPhase(page, 'scanning', 20000);
  const label = flipped ? 'upside-down texture' : 'upright texture';

  const started = Date.now();
  await waitPhase(page, 'active', 40000);
  const firstLock = Date.now() - started;
  const found = await page.evaluate(() => window.__AR__.state().experience?.id);
  check(`${label}: recognises the poster without the flag`, found === 'ceat-tyre', `${firstLock} ms including shader compile, found=${found}`);

  // A short sideways and vertical sweep: this is what lets the true width be measured.
  const path = [[0.08, 0, 0], [0.16, 0.05, 0], [0.08, 0.1, 0.05], [-0.06, 0.05, 0.1], [-0.14, -0.05, 0.05], [0, -0.1, 0], [0.12, 0, 0.08], [0, 0, 0]];
  for (const camera of path) {
    await page.evaluate((c) => { window.__sim.camera = c; }, camera);
    await page.waitForTimeout(900);
  }
  const m = await anchor(page);
  const stats = await page.evaluate(() => window.__AR__.stats());
  const err = Math.hypot(m[12], m[13], m[14] + 0.8);
  check(`${label}: poster position in the world is right`, err < 0.03, `off by ${(err * 100).toFixed(1)} cm, recognition ${stats.recogniseMs.toFixed(0)} ms`);
  check(`${label}: true width measured from camera movement`, Math.abs(m[0] - 0.4) < 0.04, `${(m[0] * 100).toFixed(1)} cm, truly 40 cm, assumed 60 cm`);

  if (!flipped) {
    // Look away, then back: content must stay put, with no search.
    await page.evaluate(() => { window.__sim.visible = false; });
    await page.waitForTimeout(1500);
    check('stays locked with the poster out of view', (await page.evaluate(() => window.__AR__.state().phase)) === 'active');
    await page.evaluate(() => { window.__sim.visible = true; });

    const t0 = Date.now();
    await page.evaluate(() => { window.__sim.poster = 1; });
    await page.waitForFunction(() => window.__AR__.state().experience?.id === 'basketball', null, { timeout: 15000 });
    await waitPhase(page, 'active', 15000);
    check('a different poster takes over', true, `${Date.now() - t0} ms`);
    const t1 = Date.now();
    await page.evaluate(() => { window.__sim.poster = 0; });
    await page.waitForFunction(() => window.__AR__.state().experience?.id === 'ceat-tyre', null, { timeout: 15000 });
    await waitPhase(page, 'active', 15000);
    check('going back to a seen poster is quick', true, `${Date.now() - t1} ms`);
    await shot(page, 'recogniser-active');
  }
  check(`${label}: no page errors`, errors.length === 0, errors.join(' | '));
  await context.close();
}

// ---- Devices without ARCore: these use the browser's real answers, not the stand-in ----
{
  const { page } = await open('?debug');
  await waitPhase(page, 'unsupported', 5000);
  await shot(page, 'unsupported');
  check('desktop is told it needs an ARCore phone', (await page.locator('[role=alert] p').innerText()).includes('ARCore'));
  await page.context().close();
}
{
  const context = await browser.newContext({ ...phone, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
  const page = await context.newPage();
  await page.addInitScript(() => Object.defineProperty(navigator, 'xr', { value: undefined }));
  await page.goto(`${base}?debug`);
  await waitPhase(page, 'unsupported', 5000);
  check('iPhone is told plainly that ARCore is unavailable', (await page.locator('[role=alert] p').innerText()).includes('iPhone'));
  await shot(page, 'unsupported-iphone');
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
