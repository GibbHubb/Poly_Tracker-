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
