// Drives every user-facing state in real Chrome, with our real tracker looking at a simulated camera: a
// poster drawn in 3D over a cluttered room, fed in through getUserMedia, with a known pose to compare
// against. It can tilt, move, blur, darken and add noise. This measures the tracker itself, but a real
// lens, real light and a real phone's speed are only covered by test-device.mjs.
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
const phone = { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, userAgent: ANDROID, permissions: ['camera', 'accelerometer', 'gyroscope'] };
const CAMERA = { width: 720, height: 1280 };
const POSTERS = ['ceat-tyre', 'basketball', 'flower', 'jelly', 'love'];

/** Runs in the page. Replaces the camera and motion sensors. `camera` and `motion` make them fail. */
function installSimulatedPhone({ camera = 'ok', motion = 'none', width, height }) {
  const focal = 0.8 * Math.max(width, height);
  const sim = { image: null, aspect: 1, scale: 0.7, x: 0, y: 0, yaw: 0, pitch: 0, roll: 0, blur: 0, noise: 0, light: 1, beta: 90, stream: null, cameraCalls: 0, motionPrompts: 0, promptInTap: false, frame: 0 };
  window.__sim = sim;

  /** The poster's corners in the camera image, or null if it's hidden. */
  sim.corners = () => {
    if (!sim.image) return null;
    const distance = focal / (width * sim.scale);
    const [cy, sy, cp, sp, cr, sr] = [Math.cos(sim.yaw), Math.sin(sim.yaw), Math.cos(sim.pitch), Math.sin(sim.pitch), Math.cos(sim.roll), Math.sin(sim.roll)];
    const hw = 0.5;
    const hh = sim.aspect / 2;
    return [[-hw, hh], [hw, hh], [hw, -hh], [-hw, -hh]].map(([px, py]) => {
      // Roll, then pitch, then yaw, then out in front of the camera. Image axes: +Y down.
      const x0 = px * cr - py * sr;
      const y0 = px * sr + py * cr;
      const y1 = y0 * cp;
      const z1 = y0 * sp;
      const x2 = x0 * cy + z1 * sy;
      const z2 = -x0 * sy + z1 * cy;
      const X = x2 + (sim.x * distance) / focal;
      const Y = -y1 + (sim.y * distance) / focal;
      const Z = z2 + distance;
      return [(focal * X) / Z + width / 2, (focal * Y) / Z + height / 2, Z];
    });
  };

  const glCanvas = document.createElement('canvas');
  glCanvas.width = width;
  glCanvas.height = height;
  const gl = glCanvas.getContext('webgl', { preserveDrawingBuffer: true });
  const shader = (type, source) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, source);
    gl.compileShader(s);
    return s;
  };
  const program = gl.createProgram();
  gl.attachShader(program, shader(gl.VERTEX_SHADER, 'attribute vec3 p; attribute vec2 t; varying vec2 v; void main(){ v=t; gl_Position=vec4(p.xy,0.0,p.z); }'));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, `precision mediump float; varying vec2 v; uniform sampler2D map; uniform float light; uniform float noise; uniform float seed;
    float r(vec2 c){ return fract(sin(dot(c+seed,vec2(12.9898,78.233)))*43758.5453); }
    void main(){ vec3 c=texture2D(map,v).rgb*light; c+=(r(gl_FragCoord.xy)-0.5)*noise; gl_FragColor=vec4(c,1.0); }`));
  gl.linkProgram(program);
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enableVertexAttribArray(0);
  gl.bindAttribLocation(program, 0, 'p');
  gl.bindAttribLocation(program, 1, 't');
  gl.linkProgram(program);
  gl.useProgram(program);
  gl.enableVertexAttribArray(1);
  const uniform = (name) => gl.getUniformLocation(program, name);
  const texture = (source) => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };

  // A cluttered room, so that the tracker has plenty of wrong features to ignore.
  const room = document.createElement('canvas');
  room.width = 512;
  room.height = 512;
  const r2d = room.getContext('2d');
  r2d.fillStyle = '#6b6f76';
  r2d.fillRect(0, 0, 512, 512);
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 260; i += 1) {
    r2d.fillStyle = `hsl(${rand() * 360},${rand() * 40}%,${20 + rand() * 60}%)`;
    r2d.fillRect(rand() * 512, rand() * 512, 4 + rand() * 40, 4 + rand() * 40);
  }
  const roomTexture = texture(room);
  const posters = new Map();

  const draw = (verts, map) => {
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
    gl.bindTexture(gl.TEXTURE_2D, map);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
  };
  const output = document.createElement('canvas');
  output.width = width;
  output.height = height;
  const ctx = output.getContext('2d');

  setInterval(() => {
    sim.frame += 1;
    sim.animate?.(sim.frame);
    gl.uniform1f(uniform('light'), sim.light);
    gl.uniform1f(uniform('noise'), sim.noise);
    gl.uniform1f(uniform('seed'), sim.frame % 97);
    draw([-1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 1, -1, 1, 1, 1, -1, -1, 1, 0, 1], roomTexture);
    const image = sim.image;
    if (image?.complete && image.naturalWidth) {
      if (!posters.has(image.src)) posters.set(image.src, texture(image));
      const c = sim.corners();
      const uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
      const verts = [];
      c.forEach(([x, y, z], i) => {
        // Written with their depth as w, so that the poster's image is correctly foreshortened.
        verts.push(((x / width) * 2 - 1) * z, (1 - (y / height) * 2) * z, z, uv[i][0], uv[i][1]);
      });
      draw(verts, posters.get(image.src));
    }
    ctx.filter = sim.blur ? `blur(${sim.blur}px)` : 'none';
    ctx.drawImage(glCanvas, 0, 0);
  }, 33);

  window.__showPoster = (id, options = {}) => {
    Object.assign(sim, { scale: 0.7, x: 0, y: 0, yaw: 0, pitch: 0, roll: 0, blur: 0, noise: 0, light: 1, animate: null }, options);
    if (!id) {
      sim.image = null;
      return;
    }
    const image = new Image();
    image.onload = () => {
      sim.aspect = image.naturalHeight / image.naturalWidth;
    };
    image.src = `assets/experiences/${id}/target.jpg`;
    sim.image = image;
  };

  navigator.mediaDevices.getUserMedia = async () => {
    sim.cameraCalls += 1;
    if (camera !== 'ok') throw new DOMException('refused by test', camera);
    sim.stream = output.captureStream(30);
    return sim.stream;
  };

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
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: sim.beta, gamma: 0, absolute: false }));
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
const startButton = (page) => page.getByRole('button', { name: 'Start AR' });
const start = async (page) => {
  await page.waitForFunction(() => window.__AR__?.state().ready, null, { timeout: 60000 });
  await startButton(page).click();
};
const alertTitle = (page) => page.locator('[role=alert] h2').innerText();
const shot = async (page, name) => {
  await page.waitForTimeout(450); // Let the screen's fade-in finish.
  await page.screenshot({ path: join(out, `ui-${name}.png`) });
};
const show = (page, id, options) => page.evaluate(([i, o]) => window.__showPoster(i, o), [id, options]);
const phaseOf = (page) => page.evaluate(() => window.__AR__.state().phase);
const cameraOn = (page) => page.evaluate(() => window.__sim.stream?.getVideoTracks().some((track) => track.readyState === 'live') ?? false);

/** How far content's corners are from the poster's true corners, on screen, in CSS pixels. */
const cornerError = (page) =>
  page.evaluate(({ width, height }) => {
    const { scene } = window.__AR__.runtime();
    const corners = window.__sim.corners();
    if (!corners) return null;
    const hw = 0.5;
    const hh = window.__sim.aspect / 2;
    const fill = Math.max(innerWidth / width, innerHeight / height);
    let worst = 0;
    [[-hw, hh], [hw, hh], [hw, -hh], [-hw, -hh]].forEach(([x, y], i) => {
      const p = scene.anchor.position.clone().set(x, y, 0).applyMatrix4(scene.anchor.matrix).applyMatrix4(scene.camera.matrixWorldInverse).applyMatrix4(scene.camera.projectionMatrix);
      const sx = ((p.x + 1) / 2) * innerWidth;
      const sy = ((1 - p.y) / 2) * innerHeight;
      const tx = (corners[i][0] - width / 2) * fill + innerWidth / 2;
      const ty = (corners[i][1] - height / 2) * fill + innerHeight / 2;
      worst = Math.max(worst, Math.hypot(sx - tx, sy - ty));
    });
    return worst;
  }, CAMERA);

// ---- Poster tracking, deep link ----
{
  const { page, errors } = await open('?t=ceat-tyre&debug');
  check('welcome: deep link shows brand copy', await page.getByRole('heading', { name: 'Grip that goes the extra mile' }).isVisible());
  await startButton(page).waitFor({ timeout: 60000 });
  await page.waitForFunction(() => window.__AR__.state().ready, null, { timeout: 60000 });
  await shot(page, 'welcome-deeplink');
  check('the camera stays off until the tap', (await page.evaluate(() => window.__sim.cameraCalls)) === 0);
  await start(page);
  await waitPhase(page, 'scanning', 30000);
  check('camera is on while scanning', await cameraOn(page));
  check('scan hint shows while searching', await page.locator('.scan__hint').isVisible());
  await page.waitForTimeout(1500);
  check('nothing is found in an empty, cluttered room', (await phaseOf(page)) === 'scanning');
  await shot(page, 'scanning');

  const t0 = Date.now();
  await show(page, 'ceat-tyre');
  await waitPhase(page, 'active', 10000);
  check('the tracker recognises the poster', true, `${Date.now() - t0} ms`);

  await page.waitForTimeout(1800); // The intro finishes, and hotspots show.
  const error = await cornerError(page);
  check('content lines up with the print', error < 6, `worst corner ${error.toFixed(1)} px`);
  await shot(page, 'active');
  const png = await page.screenshot({ clip: { x: 106, y: 300, width: 200, height: 300 } });
  const { channels } = await sharp(png).stats();
  check('tyre is drawn where the poster is', channels[0].stdev + channels[1].stdev > 10, `stdev ${channels[0].stdev.toFixed(0)}`);
  const feed = await sharp(await page.screenshot({ clip: { x: 0, y: 700, width: 412, height: 100 } })).stats();
  check('the camera image is drawn behind the content', feed.channels[0].stdev > 5, `detail stdev ${feed.channels[0].stdev.toFixed(0)}`);

  // Tap the marker on screen, the same way a finger would.
  const point = await page.evaluate(() => {
    const { scene } = window.__AR__.runtime();
    const markers = [];
    scene.scene.traverse((node) => {
      if (node.isSprite && node.renderOrder === 40) markers.push(node);
    });
    const p = markers[0].getWorldPosition(markers[0].position.clone()).applyMatrix4(scene.camera.matrixWorldInverse).applyMatrix4(scene.camera.projectionMatrix);
    return [((p.x + 1) / 2) * innerWidth, ((1 - p.y) / 2) * innerHeight];
  });
  await page.mouse.click(point[0], point[1]);
  await page.waitForTimeout(150);
  const picked = await page.evaluate(() => window.__AR__.state().hotspot?.title ?? null);
  check('tapping a hotspot selects it', !!picked, `selected=${picked}`);
  check('hotspot card appears', await page.locator('.hotspot').isVisible());
  await shot(page, 'hotspot');

  await show(page, null);
  await waitPhase(page, 'lost', 4000);
  check('losing the poster shows the lost state', await page.locator('.scan__hint').isVisible());
  await shot(page, 'lost');
  await show(page, 'ceat-tyre');
  await waitPhase(page, 'recovered', 5000);
  check('the poster coming back is recovered', true);
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

// ---- All five posters, then how far the tracker can be pushed ----
{
  const { page, errors } = await open('?debug');
  await shot(page, 'welcome');
  await start(page);
  await waitPhase(page, 'scanning', 30000);

  for (const id of POSTERS) {
    const t0 = Date.now();
    await show(page, id);
    await page.waitForFunction((i) => window.__AR__.state().experience?.id === i && window.__AR__.stats().imageState === 'tracked', id, { timeout: 15000 });
    await waitPhase(page, 'active', 20000);
    const ms = Date.now() - t0;
    await page.waitForTimeout(700);
    const error = await cornerError(page);
    check(`${id}: recognised and lines up`, error < 6, `${ms} ms, worst corner ${error.toFixed(1)} px`);
    await shot(page, `poster-${id}`);
    await show(page, null);
    await waitPhase(page, 'lost', 4000);
  }

  // Each condition starts from nothing, so this is whether the poster can be found like this at all.
  const conditions = [
    ['tilted 30 degrees', { yaw: 0.52 }],
    ['tilted 45 degrees', { yaw: 0.79 }],
    ['tilted 60 degrees', { yaw: 1.05 }],
    ['tilted down 45 degrees', { pitch: 0.79 }],
    ['rotated 90 degrees', { roll: 1.57 }],
    ['upside down', { roll: 3.14 }],
    ['small: 30% of the view', { scale: 0.3 }],
    ['small: 15% of the view', { scale: 0.15 }],
    ['close: 150% of the view', { scale: 1.5 }],
    ['off to one side', { scale: 0.45, x: 150, y: -300 }],
    ['slight blur', { blur: 1 }],
    ['heavy blur', { blur: 3 }],
    ['dim light', { light: 0.35 }],
    ['very dim, with noise', { light: 0.15, noise: 0.12 }],
    ['noisy', { noise: 0.25 }],
  ];
  const table = [];
  for (const [name, options] of conditions) {
    const row = { condition: name };
    for (const id of POSTERS) {
      await show(page, null);
      await page.waitForFunction(() => window.__AR__.stats().imageState === 'none', null, { timeout: 5000 });
      await show(page, id, options);
      const t0 = Date.now();
      const found = await page
        .waitForFunction((i) => {
          const s = window.__AR__.stats();
          return s.imageState === 'tracked' && window.__AR__.state().experience?.id === i;
        }, id, { timeout: 4000 })
        .then(() => true)
        .catch(() => false);
      await page.waitForTimeout(300);
      const error = found ? await cornerError(page) : null;
      row[id] = found ? `${Date.now() - t0 - 300}ms/${error.toFixed(0)}px` : 'no';
    }
    table.push(row);
  }
  console.table(table);
  const cases = table.flatMap((row) => POSTERS.map((id) => row[id]));
  const hits = cases.filter((c) => c !== 'no').length;
  check('recognition across hard conditions, reported above', hits > cases.length * 0.6, `${hits} of ${cases.length} found`);

  // Steadiness: the poster isn't moving, so all the movement in the content is jitter.
  await show(page, null);
  await page.waitForTimeout(800);
  await show(page, 'jelly', { noise: 0.04 });
  await page.waitForFunction(() => window.__AR__.stats().imageState === 'tracked', null, { timeout: 8000 });
  await page.waitForTimeout(1000);
  const jitter = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const { anchor } = window.__AR__.runtime().scene;
        const xs = [];
        const timer = setInterval(() => {
          xs.push([anchor.matrix.elements[12], anchor.matrix.elements[13], anchor.matrix.elements[14]]);
          if (xs.length >= 90) {
            clearInterval(timer);
            const spread = [0, 1, 2].map((axis) => {
              const values = xs.map((v) => v[axis]);
              const mean = values.reduce((a, b) => a + b) / values.length;
              return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
            });
            resolve(spread);
          }
        }, 33);
      }),
  );
  // In poster widths: on a 60 cm print, 0.001 is 0.6 mm.
  check('content holds steady on a still poster', jitter[0] < 0.003 && jitter[1] < 0.003, `spread x ${jitter[0].toFixed(4)}, y ${jitter[1].toFixed(4)}, depth ${jitter[2].toFixed(4)} poster widths`);

  // Following: a hand moving the phone around, sampled as it goes.
  for (const [name, speed, swing] of [['gentle movement', 0.06, 120], ['fast movement', 0.2, 180]]) {
    await show(page, null);
    await page.waitForTimeout(800);
    await show(page, 'flower', { scale: 0.55 });
    await page.waitForFunction(() => window.__AR__.stats().imageState === 'tracked', null, { timeout: 8000 });
    await page.evaluate(([s, a]) => {
      window.__sim.animate = (frame) => {
        const t = frame * s;
        Object.assign(window.__sim, { x: Math.sin(t) * a, y: Math.cos(t * 0.7) * a, yaw: Math.sin(t * 0.5) * 0.35, pitch: Math.cos(t * 0.3) * 0.25, roll: Math.sin(t * 0.4) * 0.3 });
      };
    }, [speed, swing]);
    await page.waitForTimeout(300);
    const followed = await page.evaluate(
      () =>
        new Promise((resolve) => {
          let tracked = 0;
          let total = 0;
          const timer = setInterval(() => {
            total += 1;
            if (window.__AR__.stats().imageState === 'tracked') tracked += 1;
            if (total >= 150) {
              clearInterval(timer);
              resolve({ share: tracked / total, stats: window.__AR__.stats() });
            }
          }, 33);
        }),
    );
    check(`${name}: stays locked`, followed.share > 0.9, `locked ${(followed.share * 100).toFixed(0)}% of the time, ${followed.stats.trackFps.toFixed(0)} fps`);
    await page.evaluate(() => {
      window.__sim.animate = null;
    });
  }

  // Speed on this machine, for each thing the tracker does. Emulated CPU slowdown doesn't reach workers,
  // so only a real phone can say more. A phone can be expected to be several times slower.
  const speedOf = async (id) => {
    await show(page, id, { scale: 0.6 });
    await page.waitForTimeout(1200);
    return page.evaluate(
      () =>
        new Promise((resolve) => {
          const { tracker } = window.__AR__.runtime().tracking.adapter.options;
          const original = tracker.onResult;
          const times = {};
          tracker.onResult = (result) => {
            (times[result.mode] ??= []).push(result.ms);
            original(result);
          };
          setTimeout(() => {
            tracker.onResult = original;
            const summary = {};
            for (const [mode, list] of Object.entries(times)) {
              list.sort((p, q) => p - q);
              summary[mode] = `${list.length} frames, median ${list[list.length >> 1].toFixed(0)} ms, worst ${list[list.length - 1].toFixed(0)} ms`;
            }
            resolve(summary);
          }, 4000);
        }),
    );
  };
  console.log('Speed, poster in view:', JSON.stringify(await speedOf('love')));
  console.log('Speed, nothing in view:', JSON.stringify(await speedOf(null)));
  check('no uncaught page errors (five posters)', errors.length === 0, errors.join(' | '));
  await page.context().close();
}

// ---- Room placement ----
{
  const { page, errors } = await open('?t=ceat-tyre&debug');
  await page.waitForFunction(() => window.__AR__.state().ready, null, { timeout: 60000 });
  await page.getByRole('button', { name: /Place the tyre/ }).click();
  await waitPhase(page, 'scanning', 30000);
  await page.waitForFunction(() => window.__AR__.state().placement === 'searching', null, { timeout: 3000 });
  check('a level phone has no floor to place on', true);
  await page.evaluate(() => {
    window.__sim.beta = 55; // Tilted down towards the floor.
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
  const before = await page.evaluate(() => {
    const { scene } = window.__AR__.runtime();
    return scene.anchor.getWorldPosition(scene.anchor.position.clone()).applyMatrix4(scene.camera.matrixWorldInverse).y;
  });
  await page.evaluate(() => {
    window.__sim.beta = 75;
  });
  await page.waitForTimeout(300);
  const moved = await page.evaluate(() => {
    const { scene } = window.__AR__.runtime();
    return scene.anchor.getWorldPosition(scene.anchor.position.clone()).applyMatrix4(scene.camera.matrixWorldInverse).y;
  });
  check('turning the phone moves the view, not the tyre', moved < before, `${before.toFixed(2)} then ${moved.toFixed(2)} in view`);
  check('no uncaught page errors (placement)', errors.length === 0, errors.join(' | '));
  await page.context().close();
}

// ---- Permission and camera failures ----
for (const [camera, title, name] of [
  ['NotAllowedError', 'Camera access is off', 'denied camera gives instructions'],
  ['NotReadableError', 'Couldn’t start the camera', 'a camera in use is reported'],
]) {
  const { page } = await open('?t=ceat-tyre&debug', { sim: { camera } });
  await start(page);
  await waitPhase(page, 'error', 15000);
  const got = await alertTitle(page);
  check(name, got.includes(title), got);
  await shot(page, `error-${camera}`);
  await page.context().close();
}

// ---- iPhone: posters need no motion, and room placement asks inside the tap ----
{
  const { page, errors } = await open('?t=ceat-tyre&debug', { sim: { motion: 'granted' }, context: { ...phone, userAgent: IPHONE } });
  await start(page);
  await waitPhase(page, 'scanning', 30000);
  check('iPhone posters need no motion prompt', (await page.evaluate(() => window.__sim.motionPrompts)) === 0);
  await show(page, 'ceat-tyre');
  await waitPhase(page, 'active', 15000);
  check('iPhone user agent: poster tracks', true);
  await page.getByRole('button', { name: 'Close' }).click();
  await waitPhase(page, 'welcome', 3000);
  await page.getByRole('button', { name: /Place the tyre/ }).click();
  await waitPhase(page, 'scanning', 30000);
  const asked = await page.evaluate(() => ({ prompts: window.__sim.motionPrompts, inTap: window.__sim.promptInTap }));
  check('iPhone room placement asks for motion inside the tap', asked.prompts > 0 && asked.inTap, JSON.stringify(asked));
  check('no uncaught page errors (iPhone)', errors.length === 0, errors.join(' | '));
  await page.context().close();
}
{
  const { page } = await open('?t=ceat-tyre&debug', { sim: { motion: 'denied' }, context: { ...phone, userAgent: IPHONE } });
  await page.waitForFunction(() => window.__AR__.state().ready, null, { timeout: 60000 });
  await page.getByRole('button', { name: /Place the tyre/ }).click();
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
  await page.route('**/targets/*.target', (route) => route.fulfill({ status: 404, body: 'gone' }));
  await page.goto(`${base}?t=ceat-tyre&debug`);
  await waitPhase(page, 'error', 60000);
  check('missing poster data is reported', (await alertTitle(page)).includes('Content'));
  await page.unroute('**/targets/*.target');
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.waitForFunction(() => window.__AR__.state().ready, null, { timeout: 60000 });
  check('retry reloads the poster data', true);
  await context.close();
}

// ---- Devices that can't run it ----
{
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  await page.addInitScript(() => {
    delete window.OffscreenCanvas;
  });
  await page.goto(`${base}?debug`);
  await waitPhase(page, 'unsupported', 10000);
  await shot(page, 'unsupported');
  check('an old browser is told to update', (await page.locator('[role=alert] p').innerText()).includes('update'));
  await context.close();
}
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${base}?debug`);
  await page.waitForFunction(() => window.__AR__?.state().ready, null, { timeout: 60000 });
  check('desktop can use a webcam, with no room placement', (await page.getByRole('button', { name: /Place the tyre/ }).count()) === 0);
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
