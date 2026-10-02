// PT32 — point clustering for the map's two point sources.
//
// MapLibre's built-in clustering (supercluster, already inside maplibre-gl) is
// used rather than thinning the data: the sidebar counts and the PDF export
// must keep seeing every feature. The export draws individual markers, so it
// switches clustering off for the capture and back on afterwards.
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';

/** Sources that cluster. Paddocks and poly runs are shapes and never do. */
export const CLUSTERED_SOURCES = ['saved-features', 'saved-photos'] as const;

/**
 * Clusters form up to zoom 14; from 15 (paddock scale) every point draws on
 * its own with its PT8 label, as before. 50 px is MapLibre's default radius.
 */
export const CLUSTER_OPTIONS = { cluster: true, clusterMaxZoom: 14, clusterRadius: 50 };

/** Layer filters: a cluster carries `point_count`, a single point does not. */
export const IS_CLUSTER = ['has', 'point_count'] as const;
export const NOT_CLUSTER = ['!', ['has', 'point_count']] as const;

/** Run `fn` (an export) with every point drawn individually, then restore. */
export async function withClustersOff<T>(map: MapLibreMap, fn: () => Promise<T>): Promise<T> {
  const sources = CLUSTERED_SOURCES.map((id) => map.getSource(id) as GeoJSONSource | undefined).filter(
    (s): s is GeoJSONSource => !!s,
  );
  // Toggle `cluster` ONLY. MapLibre 3.6's setClusterOptions writes
  // clusterRadius straight into supercluster without the EXTENT/tileSize (x16)
  // scaling the constructor applies, so passing CLUSTER_OPTIONS back shrank
  // the radius sixteen-fold and the map came back as hundreds of 2-point
  // clusters after every export. Leaving radius/maxZoom out keeps the
  // constructor's correctly scaled values.
  for (const s of sources) s.setClusterOptions({ cluster: false });
  try {
    // The export's own wait-for-idle has a silent 4 s cap; on a slow phone
    // with thousands of points that could capture the map still clustered.
    // Wait for the re-tiled sources explicitly, and fail loudly instead.
    await waitForSources(map, CLUSTERED_SOURCES.filter((id) => map.getSource(id)));
    return await fn();
  } finally {
    for (const s of sources) s.setClusterOptions({ cluster: true });
  }
}

/** Resolve once every named source has finished loading; reject after `ms`. */
export function waitForSources(map: MapLibreMap, ids: readonly string[], ms = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => ids.every((id) => map.isSourceLoaded(id));
    const started = Date.now();
    const tick = () => {
      if (done()) return resolve();
      if (Date.now() - started > ms) {
        return reject(new Error('the map did not finish redrawing the points in time — try again'));
      }
      setTimeout(tick, 50);
    };
    // setClusterOptions marks the source as loading synchronously, so the
    // first check cannot see the pre-toggle "loaded" state.
    tick();
  });
}
