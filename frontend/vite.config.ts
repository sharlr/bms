import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: { sourcemap: false, target: 'es2022' },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:4000', ws: true } },
  },
});
