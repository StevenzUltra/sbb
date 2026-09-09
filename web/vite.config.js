import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

// Dev proxies to a running `sbb ui --port 4789` (docs/spec/web-console.md).
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:4789',
      '/ws': { target: 'ws://127.0.0.1:4789', ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
