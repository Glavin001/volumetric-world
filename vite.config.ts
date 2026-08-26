import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2400,
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
