import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

/** index.html loads the engine as a plain script. Only these files are used: faces and sky aren't. */
function copyEngine() {
  const from = fileURLToPath(new URL('./node_modules/@8thwall/engine-binary/dist/', import.meta.url));
  const to = fileURLToPath(new URL('./public/external/xr/', import.meta.url));
  mkdirSync(to, { recursive: true });
  copyFileSync(`${from}xr.js`, `${to}xr.js`);
  copyFileSync(`${from}xr-slam.js`, `${to}xr-slam.js`);
  copyFileSync(`${from}LICENSE`, `${to}LICENSE.txt`);
}

export default defineConfig(({ mode }) => {
  copyEngine();
  const plugins: PluginOption[] = [react()];
  // The camera needs a secure context. `npm run dev:https` gives phones on the LAN one.
  if (mode === 'https') plugins.push(basicSsl());

  return {
    base: './',
    plugins,
    build: {
      target: 'es2021',
      chunkSizeWarningLimit: 1500,
    },
  };
});
