import { defineConfig } from 'vite';

export default defineConfig({
  root: 'frontend',
  oxc: { jsx: { runtime: 'automatic' } },
  build: {
    outDir: '../static',
    emptyOutDir: true,
    assetsDir: 'assets',
  },
  server: {
    proxy: { '/api': 'http://127.0.0.1:8000' },
  },
});
