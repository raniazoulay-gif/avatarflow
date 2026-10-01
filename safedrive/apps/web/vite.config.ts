import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@safedrive/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:4000', rewrite: (p) => p.replace(/^\/api/, '') },
      '/ws': { target: 'ws://localhost:4000', ws: true },
    },
  },
});
