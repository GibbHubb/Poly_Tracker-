/// <reference lib="webworker" />
import { precacheAndRoute, createHandlerBoundToURL } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkFirst, StaleWhileRevalidate } from 'workbox-strategies';
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
//
// PT29 — NetworkFirst, not StaleWhileRevalidate. SWR answers from the cache
// FIRST, online too, so the refresh after a save (or after the offline queue
// drained) was handed the list from BEFORE the save: measured, a synced farm
// showed 5 points where the server held 4. Online now always asks the server;
// the cache only answers when the network does not (offline, or > 5 s).
registerRoute(
  ({ url, request }) =>
    url.pathname.startsWith('/api/') && request.method === 'GET',
  new NetworkFirst({
    networkTimeoutSeconds: 5,
    cacheName: 'api-cache',
    // PT29 — bounded. The farm snapshot in IndexedDB is now the offline copy
    // that matters; this cache is a fallback and must not grow forever.
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({
        maxEntries: 200,
        maxAgeSeconds: 60 * 60 * 24 * 30,
        purgeOnQuotaError: true,
      }),
      // Mark a cache fallback, so the app never stores or labels it as fresh.
      {
        cachedResponseWillBeUsed: async ({ cachedResponse }) => {
          if (!cachedResponse) return null;
          const headers = new Headers(cachedResponse.headers);
          headers.set('x-pt-from-cache', '1');
          return new Response(await cachedResponse.blob(), {
            status: cachedResponse.status,
            statusText: cachedResponse.statusText,
            headers,
          });
        },
      },
    ],
  }),
);

self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
