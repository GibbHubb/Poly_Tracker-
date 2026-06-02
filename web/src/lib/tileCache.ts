// Offline satellite-tile pre-download (PT11). Tile bytes go into the
// 'offline-tiles' Cache Storage cache (served by the SW cache-first); a
// lightweight per-area manifest is kept in Dexie for the "manage areas" list.

import { db, type OfflineArea } from './db';
import {
  BULK_SAFE_PROVIDERS,
  lngLatToTile,
  tileUrl,
  type BasemapProvider,
} from './mapStyle';

const CACHE_NAME = 'offline-tiles';
/** Hard cap on tiles per area — guards browser quota (~50–150 MB of JPEGs). */
export const TILE_CAP = 1500;
/** Rough average 256px satellite JPEG size, used only for size estimates. */
const AVG_TILE_BYTES = 35 * 1024;

export interface AreaBounds {
  w: number;
  s: number;
  e: number;
  n: number;
}

export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

export function canDownload(provider: BasemapProvider): boolean {
  return BULK_SAFE_PROVIDERS.has(provider);
}

/** Enumerate every XYZ tile covering `b` across `[zMin..zMax]`. */
export function tilesForBounds(
  b: AreaBounds,
  zMin: number,
  zMax: number,
): TileCoord[] {
  const tiles: TileCoord[] = [];
  for (let z = zMin; z <= zMax; z += 1) {
    const nw = lngLatToTile(b.w, b.n, z); // top-left → min x, min y
    const se = lngLatToTile(b.e, b.s, z); // bottom-right → max x, max y
    for (let x = nw.x; x <= se.x; x += 1) {
      for (let y = nw.y; y <= se.y; y += 1) {
        tiles.push({ z, x, y });
      }
    }
  }
  return tiles;
}

export interface AreaEstimate {
  tileCount: number;
  bytes: number;
  overCap: boolean;
}

export function estimateArea(
  b: AreaBounds,
  zMin: number,
  zMax: number,
): AreaEstimate {
  const tileCount = tilesForBounds(b, zMin, zMax).length;
  return {
    tileCount,
    bytes: tileCount * AVG_TILE_BYTES,
    overCap: tileCount > TILE_CAP,
  };
}

export interface DownloadProgress {
  done: number;
  total: number;
}

/** Fetch every tile for the area and store it in the offline-tiles cache. */
export async function downloadArea(opts: {
  name: string;
  provider: BasemapProvider;
  bounds: AreaBounds;
  zMin: number;
  zMax: number;
  onProgress?: (p: DownloadProgress) => void;
  signal?: AbortSignal;
}): Promise<OfflineArea> {
  const { name, provider, bounds, zMin, zMax, onProgress, signal } = opts;
  if (!canDownload(provider)) {
    throw new Error(`Offline download isn't permitted for "${provider}".`);
  }
  const tiles = tilesForBounds(bounds, zMin, zMax);
  if (tiles.length > TILE_CAP) {
    throw new Error(
      `Area too large: ${tiles.length} tiles (cap ${TILE_CAP}). Zoom in or reduce depth.`,
    );
  }
  // Pre-flight quota check.
  if (navigator.storage?.estimate) {
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    if (quota && usage + tiles.length * AVG_TILE_BYTES > quota) {
      throw new Error(
        'Not enough storage for this area — clear other offline areas or reduce the selection.',
      );
    }
  }

  const cache = await caches.open(CACHE_NAME);
  let done = 0;
  for (const t of tiles) {
    if (signal?.aborted) {
      throw new DOMException('Download cancelled', 'AbortError');
    }
    const url = tileUrl(provider, t.z, t.x, t.y);
    try {
      const res = await fetch(url, { signal });
      if (res.ok) await cache.put(url, res.clone());
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') throw err;
      // Skip individual tile failures (e.g. out-of-coverage) and keep going.
    }
    done += 1;
    onProgress?.({ done, total: tiles.length });
  }

  const area: OfflineArea = {
    id: crypto.randomUUID(),
    name,
    provider,
    bounds: [bounds.w, bounds.s, bounds.e, bounds.n],
    zMin,
    zMax,
    tileCount: tiles.length,
    bytes: tiles.length * AVG_TILE_BYTES,
    createdAt: Date.now(),
  };
  await db.offlineAreas.put(area);
  return area;
}

export async function listAreas(): Promise<OfflineArea[]> {
  return db.offlineAreas.orderBy('createdAt').reverse().toArray();
}

/** Delete an area's manifest entry and its tiles from the cache. (Tiles
 *  shared with another saved area are removed too — acceptable for v1.) */
export async function clearArea(area: OfflineArea): Promise<void> {
  const cache = await caches.open(CACHE_NAME);
  const [w, s, e, n] = area.bounds;
  const tiles = tilesForBounds({ w, s, e, n }, area.zMin, area.zMax);
  await Promise.all(
    tiles.map((t) =>
      cache.delete(
        tileUrl(area.provider as BasemapProvider, t.z, t.x, t.y),
      ),
    ),
  );
  await db.offlineAreas.delete(area.id);
}
