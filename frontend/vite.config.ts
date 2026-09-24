import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const runtimeProcess = (globalThis as any).process;

export default defineConfig({
  plugins: [react()],
  base: runtimeProcess?.env?.VITE_BASE_PATH || '/',
  build: {
    rollupOptions: {
      output: {
        // MapLibre changes far less often than Raven itself; a separate chunk stays cached across releases.
        manualChunks: { maplibre: ['maplibre-gl'] }
      }
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8742'
    }
  }
});
