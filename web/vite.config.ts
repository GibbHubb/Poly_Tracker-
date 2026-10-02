import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectManifest: {
        // PT16 — `pbf` added so the self-hosted glyph ranges are precached.
        // Without it the files ship but are only fetched on demand, which is
        // exactly the online-only behaviour PT16 exists to remove.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,pbf}'],
      },
      manifest: {
        name: 'Poly Tracker',
        short_name: 'PolyTracker',
        description: 'Offline GIS for cattle-farm water infrastructure',
        theme_color: '#0f766e',
        background_color: '#0f172a',
        display: 'standalone',
        start_url: '/',
        icons: [],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: [
      // PT32 — MapLibre's default build inlines its 338 kB web worker as a
      // string inside the 763 kB main file, which the page must download and
      // parse before the map can start. The CSP build ships the worker as a
      // separate file (see `workerUrl` in MapView.tsx): the main file drops to
      // 694 kB and the worker downloads in parallel. Same version, same API;
      // TypeScript still resolves the bare specifier to the package's typings.
      // Exact match only, so `maplibre-gl/dist/maplibre-gl.css` is untouched.
      { find: /^maplibre-gl$/, replacement: 'maplibre-gl/dist/maplibre-gl-csp.js' },
    ],
  },
  build: {
    // PT32 — vite's 500 kB warning is noise next to a hard budget. The real
    // gate is `npm run check:bundle` (scripts/check-bundle-budget.mjs), which
    // fails CI when any chunk is over 700 kB; this only matches the warning.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // PT32 — MapLibre and mapbox-gl-draw change only on a dependency bump,
        // so each gets a long-lived chunk of its own instead of riding inside
        // the map screen's chunk and being re-downloaded on every app release.
        // (Two chunks, not one: together they are ~756 kB, over the budget.)
        manualChunks(id) {
          // Rollup's CommonJS interop helpers are shared by the entry (dexie,
          // zustand) and MapLibre. Left alone they land in the maplibre chunk
          // and the entry imports it statically — every screen then downloads
          // MapLibre, which is exactly what this split exists to stop.
          if (id.includes('commonjsHelpers')) return 'cjs-helpers';
          if (/[\\/]node_modules[\\/]maplibre-gl[\\/]/.test(id)) return 'maplibre';
          if (/[\\/]node_modules[\\/]@mapbox[\\/]mapbox-gl-draw[\\/]/.test(id)) return 'mapbox-gl-draw';
          return undefined;
        },
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY ?? 'http://api:3001',
        changeOrigin: true,
      },
    },
  },
});
