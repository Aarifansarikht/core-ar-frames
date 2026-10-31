// Compiles the supplied target images into MindAR .mind feature sets. The compiler is GPU-based,
// so it runs in headless Chrome via a small page served by Vite.
//   all.mind        every poster, used when scanning without a deep link
//   <id>.mind       one poster, used for /?t=<id> QR deep links (faster, no cross-target matches)
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ids = ['ceat-tyre', 'basketball', 'flower', 'jelly', 'love'];
const outDir = join(root, 'public', 'assets', 'targets');
mkdirSync(outDir, { recursive: true });

const server = await createServer({ root, server: { port: 5199, strictPort: true }, logLevel: 'warn' });
await server.listen();
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('page error:', e.message));
page.on('console', (m) => console.log(`[page] ${m.text()}`));
page.setDefaultTimeout(0);
await page.goto('http://localhost:5199/scripts/compile-page.html');
await page.waitForFunction(() => window.compileReady === true, null, { timeout: 120000 });
console.log('renderer:', await page.evaluate(() => window.gpuName()));

const compile = async (name, list) => {
  const t0 = Date.now();
  const urls = list.map((id) => `/assets/experiences/${id}/target.jpg`);
  const b64 = await page.evaluate((u) => window.compileTargets(u), urls);
  const file = join(outDir, `${name}.mind`);
  writeFileSync(file, Buffer.from(b64, 'base64'));
  console.log(`${name}.mind  ${(statSync(file).size / 1024).toFixed(0)} KB  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
};

const only = process.argv.slice(2);
for (const id of ids) if (!only.length || only.includes(id)) await compile(id, [id]);
if (!only.length || only.includes('all')) await compile('all', ids);

await browser.close();
await server.close();
process.exit(0);
