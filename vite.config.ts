import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig(({ mode }) => {
  const plugins: PluginOption[] = [react()];
  // WebXR needs a secure context. `npm run dev:https` gives phones on the LAN one.
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
