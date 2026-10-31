// Tests poster tracking on a real Android phone attached over USB, using `adb reverse` so that
// http://localhost is a secure context on the device. Before running: enable USB debugging and keep the
// phone unlocked.
//
//   npm run build && npm run test:device -- ceat-tyre
//
// While it runs, point the phone at the poster, turn away from it, then point back. It records what
// the tracker reports, how long the first lock took, and what happened each time the poster came back.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import { adb, connectPhoneChrome, reversePort } from './lib-device.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '.test-output');
mkdirSync(out, { recursive: true });
const PORT = 5180;
const poster = process.argv[2] ?? 'ceat-tyre';
const RUN_MS = 45000;

const server = await preview({ root, preview: { port: PORT, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' });
reversePort(PORT);
const { browser, context } = await connectPhoneChrome();
const report = {
  poster,
  model: adb('shell', 'getprop', 'ro.product.model'),
  android: adb('shell', 'getprop', 'ro.build.version.release'),
};

const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text());
});
await page.goto(`http://localhost:${PORT}/?t=${poster}&debug`);
const cdp = await context.newCDPSession(page);
const evalGesture = async (expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) return { threw: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
  return r.result.value;
};

report.ua = await evalGesture('navigator.userAgent');
await page.waitForFunction(() => window.__AR__?.state().ready || window.__AR__?.state().phase !== 'welcome', null, { timeout: 60000 });

console.log(`Starting the session. Accept any prompt on the phone, then point it at the ${poster} poster.`);
await evalGesture(`document.querySelector('button.button--primary')?.click()`);
await page.waitForFunction(() => ['scanning', 'error', 'unsupported'].includes(window.__AR__.state().phase), null, { timeout: 60000 });
report.afterStart = await page.evaluate(() => ({ phase: window.__AR__.state().phase, error: window.__AR__.state().error?.title ?? null }));

if (report.afterStart.phase === 'scanning') {
  console.log(`Recording for ${RUN_MS / 1000} s. Lock the poster, turn away, then point back. Repeat a few times.`);
  const timeline = [];
  const fps = [];
  const started = Date.now();
  let firstLockMs = null;
  while (Date.now() - started < RUN_MS) {
    const s = await page.evaluate(() => ({ phase: window.__AR__.state().phase, stats: window.__AR__.stats() }));
    const key = `${s.phase}/${s.stats?.imageState}/${s.stats?.mode}`;
    if (s.stats?.trackFps) fps.push(s.stats.trackFps);
    if (timeline.at(-1)?.state !== key) timeline.push({ atMs: Date.now() - started, state: key });
    if (firstLockMs === null && s.stats?.imageState === 'tracked') firstLockMs = Date.now() - started;
    report.lastStats = s.stats;
    await page.waitForTimeout(100);
  }
  report.firstLockMs = firstLockMs;
  report.trackFps = fps.sort((a, b) => a - b)[fps.length >> 1] ?? null;
  report.timeline = timeline;
  await page.getByRole('button', { name: 'Close' }).tap().catch(() => undefined);
}
report.errors = errors;

console.log(JSON.stringify(report, null, 1));
writeFileSync(join(out, 'report-device.json'), JSON.stringify(report, null, 1));

await page.close();
await browser.close();
await server.close();
adb('reverse', '--remove', `tcp:${PORT}`);
process.exit(0);
