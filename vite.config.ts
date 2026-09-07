import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The frontend is always built on CI and shipped prebuilt in the release tarball —
 * the Raspberry Pi must never compile it (T9/T43).
 */
export default defineConfig({
  root: resolve(__dirname, 'src/frontend'),
  base: '/',
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, 'dist/frontend'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'https://127.0.0.1:8443',
        changeOrigin: true,
        // The dev backend serves a self-signed certificate.
        secure: false,
      },
    },
  },
});
