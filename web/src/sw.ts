/// <reference lib="webworker" />
import { precacheAndRoute, createHandlerBoundToURL } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst, StaleWhileRevalidate } from 'workbox-strategies';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { ExpirationPlugin } from 'workbox-expiration';

declare let self: ServiceWorkerGlobalScope;

// App shell — injected by vite-plugin-pwa (injectManifest strategy).
precacheAndRoute(self.__WB_MANIFEST);

// PT21 — serve the shell for ANY route the SPA router owns.
//
// `precacheAndRoute` matches by URL, so it answers `/` (via directoryIndex) and
// every hashed asset — but not `/farms/<uuid>`, which is not a file and is not
// in the manifest. Offline, that navigation fell through to the network and
// died with ERR_INTERNET_DISCONNECTED: the worker was registered, controlling,
// and had the whole app precached, and reloading the page you were actually
// standing on still failed. For an app whose premise is a paddock with no
// signal, that is the case that matters.
//
// `/api` is denylisted so a direct hit on an endpoint is answered by the
// function, not with HTML — the same HTML-at-200 confusion PT21's single-origin
// layout exists to prevent, and it would be silly to reintroduce it here.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    denylist: [/^\/api\//],
  }),
);

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
