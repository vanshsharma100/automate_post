import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The web app lives in ./web and builds into ./server/public, which the
// Express server serves as static assets. A single origin (localhost:3001)
// serves both the SPA and the /api/v1 surface.
export default defineConfig({
  root: 'web',
  // Absolute base so hashed assets resolve to /assets/… on every route. With a
  // relative base, a hard load of a 2-segment route like /composer/:id resolves
  // ./assets/… against /composer/ and 404s (blank page on refresh/deep-link).
  base: '/',
  plugins: [react()],
  build: {
    outDir: '../server/public',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
