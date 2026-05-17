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
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
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
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY ?? 'http://api:3001',
        changeOrigin: true,
      },
    },
  },
});
