import { fileURLToPath } from 'node:url';
import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

const tfjsLite = fileURLToPath(new URL('./src/vendor/tfjs-lite.ts', import.meta.url));

export default defineConfig(({ mode }) => {
  const plugins: PluginOption[] = [react()];
  // Cameras need a secure context. `npm run dev:https` gives phones on the LAN one.
  if (mode === 'https') plugins.push(basicSsl());

  return {
    base: './',
    plugins,
    resolve: {
      // MindAR imports the full tfjs umbrella but only uses core + the WebGL backend.
      alias: { '@tensorflow/tfjs': tfjsLite },
    },
    // MindAR ships source that uses `?worker&inline`, which only Vite's own pipeline understands.
    optimizeDeps: {
      exclude: ['mind-ar'],
      include: ['mind-ar > @msgpack/msgpack', 'mind-ar > tinyqueue', 'mind-ar > ml-matrix', 'mind-ar > svd-js'],
    },
    worker: { format: 'es' },
    build: {
      target: ['es2021', 'safari15'],
      chunkSizeWarningLimit: 1500,
    },
  };
});
