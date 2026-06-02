/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst, StaleWhileRevalidate } from 'workbox-strategies';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { ExpirationPlugin } from 'workbox-expiration';

declare let self: ServiceWorkerGlobalScope;

// App shell — injected by vite-plugin-pwa (injectManifest strategy).
precacheAndRoute(self.__WB_MANIFEST);

// Pre-downloaded offline tiles (PT11) for bulk-safe providers (Esri / QLD).
// CacheFirst on the same 'offline-tiles' cache the app writes to, so a
// downloaded area renders with no connectivity. Registered BEFORE the
// StaleWhileRevalidate route below so it wins for these hosts.
registerRoute(
  ({ url }) =>
    (url.hostname.endsWith('arcgisonline.com') &&
      url.pathname.includes('/MapServer/tile/')) ||
    (url.hostname === 'spatial-img.information.qld.gov.au' &&
      url.pathname.includes('/ImageServer/tile/')),
  new CacheFirst({
    cacheName: 'offline-tiles',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({
        maxEntries: 6000,
        maxAgeSeconds: 60 * 60 * 24 * 180,
        purgeOnQuotaError: true,
      }),
    ],
  }),
);

// Satellite raster tiles (Mapbox or Esri — user-switchable): serve from
// cache, refresh in background. ~100 tiles per zoom across ~22 levels.
registerRoute(
  ({ url }) =>
    (url.hostname === 'api.mapbox.com' && url.pathname.startsWith('/v4/')) ||
    (url.hostname.endsWith('arcgisonline.com') &&
      url.pathname.includes('/MapServer/tile/')),
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
