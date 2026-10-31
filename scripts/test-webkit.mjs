// Runs the tracker in Playwright's desktop WebKit, with a canvas showing the poster as the camera.
// This is the same engine family as Safari but NOT iOS Safari: it finds JavaScript and shader
// incompatibilities, and says nothing about iPhone camera handling, performance or memory limits.
//
//   npx playwright-core install webkit && node scripts/test-webkit.mjs
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { webkit } from 'playwright-core';
import { preview } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '.test-output');
mkdirSync(out, { recursive: true });
const PORT = 5179;

const server = await preview({ root, preview: { port: PORT, strictPort: true }, logLevel: 'error' });
const browser = await webkit.launch();
const page = await (await browser.newContext({ viewport: { width: 412, height: 915 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

await page.addInitScript(() => {
  // Test-only camera: draws the poster onto a canvas with slight drift, exposed as a MediaStream.
  const makeStream = async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 720;
    canvas.height = 1280;
    const ctx = canvas.getContext('2d');
    const img = new Image();
    img.src = 'assets/experiences/ceat-tyre/target.jpg';
    await img.decode();
    const draw = (t) => {
      ctx.fillStyle = '#bbb';
      ctx.fillRect(0, 0, 720, 1280);
      ctx.drawImage(img, 20 + Math.sin(t / 900) * 6, 440 + Math.cos(t / 700) * 6, 680, 378);
      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
    return canvas.captureStream(30);
  };
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: makeStream, enumerateDevices: async () => [] },
  });
});

await page.goto(`http://localhost:${PORT}/?t=ceat-tyre&debug`);
const report = { ua: await page.evaluate(() => navigator.userAgent), welcome: await page.evaluate(() => window.__AR__?.state().phase) };
const gl = await page.evaluate(() => {
  const c = document.createElement('canvas').getContext('webgl2');
  return c ? c.getParameter(c.VERSION) : null;
});
report.webgl2 = gl;
if (gl && report.welcome === 'welcome') {
  await page.getByRole('button', { name: 'Start AR' }).click();
  const final = await page
    .waitForFunction(() => ['active', 'error'].includes(window.__AR__.state().phase), null, { timeout: 90000 })
    .then(() => page.evaluate(() => window.__AR__.state().phase))
    .catch(() => 'timeout');
  report.phase = final;
  report.error = await page.evaluate(() => window.__AR__.state().error);
  await page.waitForTimeout(2500);
  report.stats = await page.evaluate(() => window.__AR__.stats());
  await page.screenshot({ path: join(out, 'webkit-active.png') });
}
report.errors = errors;
console.log(JSON.stringify(report, null, 1));
await browser.close();
await server.close();
process.exit(0);
