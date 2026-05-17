/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { StaleWhileRevalidate } from 'workbox-strategies';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { ExpirationPlugin } from 'workbox-expiration';

declare let self: ServiceWorkerGlobalScope;

// App shell — injected by vite-plugin-pwa (injectManifest strategy).
precacheAndRoute(self.__WB_MANIFEST);

// Mapbox raster tiles: serve from cache, refresh in the background.
// Approx. "last 100 tiles per zoom level" across ~22 zoom levels.
registerRoute(
  ({ url }) => url.hostname === 'api.mapbox.com' && url.pathname.includes('/tiles/'),
  new StaleWhileRevalidate({
    cacheName: 'mapbox-tiles',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({
        maxEntries: 100 * 22,
        maxAgeSeconds: 60 * 60 * 24 * 30,
        purgeOnQuotaError: true,
      }),
    ],
  }),
);

// API GET responses — last-known data when offline.
registerRoute(
  ({ url, request }) =>
    url.pathname.startsWith('/api/') && request.method === 'GET',
  new StaleWhileRevalidate({
    cacheName: 'api-cache',
    plugins: [new CacheableResponsePlugin({ statuses: [0, 200] })],
  }),
);

self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
