// PT43 review — NetworkFirst falls back to the cache only when the network
// THROWS. A 429 (the API's rate limit) or a 5xx is a successful fetch to
// Workbox, so it was handed to the page as-is and the farm screen showed an
// error while a perfectly good cached copy sat in `api-cache`.
//
// This plugin turns those statuses into a failure, so NetworkFirst tries the
// cache. When the cache has nothing either, the real server response is handed
// back (not a synthetic network error), so the page still sees the status, the
// body and the request id it would have seen without the service worker.
//
// Plain objects with the two Workbox plugin callbacks; no workbox import, so
// it is testable in Node.

export function isServerTrouble(status: number): boolean {
  return status === 429 || status >= 500;
}

export class ServerTroubleError extends Error {
  constructor(public readonly status: number) {
    super(`server answered ${status}; trying the cache`);
  }
}

export function createServerErrorFallbackPlugin() {
  // Keyed by URL: the request object handlerDidError receives is not the one
  // fetchDidSucceed saw (Workbox clones it).
  const stashed = new Map<string, Response>();
  return {
    fetchDidSucceed: async ({ request, response }: { request: Request; response: Response }) => {
      // An entry is left behind when the cache did answer; keep the map small.
      if (stashed.size > 50) stashed.clear();
      if (!isServerTrouble(response.status)) {
        stashed.delete(request.url);
        return response;
      }
      stashed.set(request.url, response);
      throw new ServerTroubleError(response.status);
    },
    handlerDidError: async ({ request }: { request: Request }) => {
      const original = stashed.get(request.url);
      stashed.delete(request.url);
      return original;
    },
  };
}
