import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  plugins: [react()],
  // BlockNote is ~400 kB gzipped; translations load separately on demand.
  build: { outDir: '../dist/client', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
