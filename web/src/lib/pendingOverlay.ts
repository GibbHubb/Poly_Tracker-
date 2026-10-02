// PT29 — what the user sees = the last known server state + their own queued edits.
//
// Offline, a drawn trough used to vanish the moment the dialog closed: MapView
// deletes the drawn shape expecting it back from the server, and the server was
// unreachable. So the queue is rendered as an overlay on top of the snapshot.
//
// Pure on purpose: one definition of "what is on screen", testable without a
// browser. The snapshot itself is never modified, so it never lies about what
// the server holds, and an overlay row disappears on its own once the replay
// deletes the queue entry it came from.

import type { GeoJsonFeature, GeoJsonFeatureCollection } from './api';
import type { PendingMutation } from './db';

export interface FarmCollections {
  paddocks: GeoJsonFeatureCollection;
  polyRuns: GeoJsonFeatureCollection;
  features: GeoJsonFeatureCollection;
}

type CollectionKey = keyof FarmCollections;

const SEGMENT: Record<string, CollectionKey> = {
  paddocks: 'paddocks',
  'poly-runs': 'polyRuns',
  features: 'features',
};

/** Prefix of an overlay row's id. Only ever on `feature.id`, never in a payload. */
export const PENDING_ID_PREFIX = 'pending:';

/** Property marking a row as not yet on the server (styled dashed/faded, not editable). */
export const PENDING_PROP = '_pending';

export function isPendingFeature(f: GeoJsonFeature): boolean {
  return f.properties?.[PENDING_PROP] === true;
}

interface Target {
  key: CollectionKey;
  id: string | null;
}

/** `/farms/<farmId>/<collection>[/<id>]` → which collection and row; null for anything else. */
export function targetOf(endpoint: string, farmId: string): Target | null {
  const parts = endpoint.split('/').filter(Boolean);
  if (parts[0] !== 'farms' || parts[1] !== farmId) return null;
  const key = SEGMENT[parts[2] ?? ''];
  if (!key) return null;
  if (parts.length === 3) return { key, id: null };
  if (parts.length === 4) return { key, id: parts[3]! };
  return null;
}

function asFeature(payload: unknown): Partial<GeoJsonFeature> {
  return payload && typeof payload === 'object' ? (payload as Partial<GeoJsonFeature>) : {};
}

/**
 * Apply queued mutations for `farmId`, oldest first, to copies of `base`.
 * Creates append a faded row; updates merge properties/geometry into the row;
 * deletes remove it. Mutations for other farms, or for rows that are not in
 * the snapshot, are ignored rather than guessed at.
 */
export function applyPending(
  base: FarmCollections,
  pending: readonly PendingMutation[],
  farmId: string,
): FarmCollections {
  const out: Record<CollectionKey, GeoJsonFeature[]> = {
    paddocks: [...base.paddocks.features],
    polyRuns: [...base.polyRuns.features],
    features: [...base.features.features],
  };
  const ordered = [...pending].sort((a, b) => a.createdAt - b.createdAt);

  for (const m of ordered) {
    const t = targetOf(m.endpoint, farmId);
    if (!t) continue;
    const rows = out[t.key];
    const p = asFeature(m.payload);

    if (m.method === 'POST' && t.id === null) {
      if (!p.geometry) continue;
      rows.push({
        type: 'Feature',
        id: `${PENDING_ID_PREFIX}${m.id}`,
        geometry: p.geometry,
        properties: { ...(p.properties ?? {}), [PENDING_PROP]: true },
      });
    } else if (m.method === 'PATCH' && t.id !== null) {
      const i = rows.findIndex((f) => String(f.id) === t.id);
      if (i < 0) continue;
      const cur = rows[i]!;
      rows[i] = {
        ...cur,
        geometry: p.geometry ?? cur.geometry,
        properties: { ...cur.properties, ...(p.properties ?? {}), [PENDING_PROP]: true },
      };
    } else if (m.method === 'DELETE' && t.id !== null) {
      const i = rows.findIndex((f) => String(f.id) === t.id);
      if (i >= 0) rows.splice(i, 1);
    }
  }

  return {
    paddocks: { type: 'FeatureCollection', features: out.paddocks },
    polyRuns: { type: 'FeatureCollection', features: out.polyRuns },
    features: { type: 'FeatureCollection', features: out.features },
  };
}

/**
 * For exports (GeoJSON, CSV, PDF): queued rows are kept (they are what the user
 * drew) but lose the internal markers: the temp `pending:` id and `_pending`.
 */
export function forExport(fc: GeoJsonFeatureCollection): GeoJsonFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: fc.features.map((f) => {
      if (!isPendingFeature(f)) return f;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [PENDING_PROP]: _drop, ...properties } = f.properties;
      const id = typeof f.id === 'string' && f.id.startsWith(PENDING_ID_PREFIX) ? undefined : f.id;
      return { ...f, id, properties };
    }),
  };
}

/** How many queued mutations belong to this farm (drives "refresh once they drain"). */
export function pendingForFarm(pending: readonly PendingMutation[], farmId: string): number {
  return pending.filter((m) => targetOf(m.endpoint, farmId) !== null).length;
}
