import { copyFileSync, mkdirSync } from 'node:fs';
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

export default defineConfig(({ mode }) => {
  copyOpenCv();
  const plugins: PluginOption[] = [react()];
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
