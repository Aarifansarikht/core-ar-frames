import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

/** The tracker's worker loads OpenCV as a plain script, which is too big to go through the bundler. */
function copyOpenCv() {
  const from = fileURLToPath(new URL('./node_modules/@techstark/opencv-js/', import.meta.url));
  const to = fileURLToPath(new URL('./public/external/opencv/', import.meta.url));
  mkdirSync(to, { recursive: true });
  copyFileSync(`${from}dist/opencv.js`, `${to}opencv.js`);
  copyFileSync(`${from}LICENSE`, `${to}LICENSE.txt`);
}

/** Lets the admin panel save its settings into the project. Only from this machine, and only under the dev server. */
function adminSave(): PluginOption {
  return {
    name: 'bay81-admin-save',
    configureServer(server) {
      server.middlewares.use('/__admin/tracking', (req, res) => {
        const address = req.socket.remoteAddress ?? '';
        // The origin check stops other websites open in the same browser from sending settings here.
        const origin = req.headers.origin;
        const sameSite = !origin || new URL(origin).host === req.headers.host;
        if (req.method !== 'POST' || !sameSite || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) {
          res.statusCode = 403;
          res.end();
          return;
        }
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          try {
            if (body.length > 1_000_000 || typeof JSON.parse(body).posters !== 'object') throw new Error('Not tracking settings');
            writeFileSync(fileURLToPath(new URL('./public/assets/tracking.json', import.meta.url)), body);
            res.statusCode = 204;
          } catch {
            res.statusCode = 400;
          }
          res.end();
        });
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  copyOpenCv();
  const plugins: PluginOption[] = [react(), adminSave()];
  // The camera needs a secure context. `npm run dev:https` gives phones on the LAN one.
  if (mode === 'https') plugins.push(basicSsl());

  return {
    base: './',
    plugins,
    worker: { format: 'iife' },
    build: {
      target: 'es2021',
      chunkSizeWarningLimit: 1500,
    },
  };
});
