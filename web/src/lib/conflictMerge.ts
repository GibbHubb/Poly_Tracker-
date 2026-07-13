// Field-level conflict merge (PT18). Pure functions — no network or Dexie.
//
// On Re-apply of a server-wins conflict we fetch the CURRENT server record,
// diff it against the user's stored payload, and let the user decide per field
// whether to push their value or keep the server's. Because the routers
// FULL-REPLACE owned attributes on PATCH (an omitted property is nulled), the
// merged PATCH carries the user's complete (correctly-typed) property set with
// only the "keep server" fields overlaid from current server state — so every
// unchanged field keeps the server's value and only the user's edits differ.

import type { GeoJsonFeature, GeoJsonGeometry } from './api';

// Server-managed / derived keys that must never be diffed or sent in a PATCH.
const IGNORED_KEYS = new Set(['id', 'created_at', 'area_m2', 'length_m', '_kind']);

/** Sentinel field name for the geometry row in a diff. */
export const GEOMETRY_FIELD = '__geometry__';

export interface FieldDiff {
  field: string;
  mine: unknown;
  server: unknown;
}

interface FeatureLike {
  properties?: Record<string, unknown> | null;
  geometry?: unknown;
}

/**
 * The single-record GET URL for a conflict. Update conflicts already carry the
 * full record path (…/paddocks/<id>). Creates (POST) have no server record and
 * deletes are handled separately, so both return null (not mergeable).
 */
export function deriveRecordUrl(endpoint: string, method: string): string | null {
  return method === 'PATCH' ? endpoint : null;
}

function norm(v: unknown): string {
  return JSON.stringify(v ?? null);
}

function roundCoords(v: unknown): unknown {
  if (typeof v === 'number') return Math.round(v * 1e7) / 1e7;
  if (Array.isArray(v)) return v.map(roundCoords);
  return v ?? null;
}

/** Canonical geometry string (coords rounded to ~1cm) so float serialization
 *  noise doesn't register as a change. */
function normGeometry(g: unknown): string {
  if (g == null) return 'null';
  const geom = g as GeoJsonGeometry;
  return JSON.stringify({ type: geom.type, coordinates: roundCoords(geom.coordinates) });
}

/** Per-field diff of the user's payload vs current server state. Derived keys
 *  are skipped. Geometry is compared only when the payload carries one (the
 *  edit dialog omits geometry on attribute-only edits). */
export function diffFields(mine: FeatureLike, server: FeatureLike): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  const myProps = mine.properties ?? {};
  const svProps = server.properties ?? {};
  const keys = new Set([...Object.keys(myProps), ...Object.keys(svProps)]);
  for (const key of keys) {
    if (IGNORED_KEYS.has(key)) continue;
    if (norm(myProps[key]) !== norm(svProps[key])) {
      diffs.push({ field: key, mine: myProps[key], server: svProps[key] });
    }
  }
  if (mine.geometry !== undefined && mine.geometry !== null) {
    if (normGeometry(mine.geometry) !== normGeometry(server.geometry)) {
      diffs.push({ field: GEOMETRY_FIELD, mine: mine.geometry, server: server.geometry });
    }
  }
  return diffs;
}

/** pg serialises NUMERIC columns as strings; if the user's value for a field is
 *  a number, coerce the server's numeric-string back to a number so it passes
 *  the router's Zod number schema. Otherwise use the server value verbatim. */
function coerceLike(mineVal: unknown, serverVal: unknown): unknown {
  if (
    typeof mineVal === 'number' &&
    typeof serverVal === 'string' &&
    /^-?\d+(\.\d+)?$/.test(serverVal)
  ) {
    return Number(serverVal);
  }
  return serverVal;
}

/**
 * Build the PATCH body to re-enqueue. Starts from the user's payload properties
 * (complete + correctly typed, since the app always submits the full set), then
 * overlays the current server value for every field in `keepServerFields`.
 * Geometry: the user's geometry is included unless the user keeps the server's
 * (in which case it's omitted and the router's COALESCE preserves server geom).
 */
export function buildMergedPatch(
  mine: FeatureLike,
  server: FeatureLike,
  keepServerFields: Set<string>,
): Partial<GeoJsonFeature> {
  const props: Record<string, unknown> = { ...(mine.properties ?? {}) };
  for (const k of IGNORED_KEYS) delete props[k];

  const svProps = server.properties ?? {};
  for (const field of keepServerFields) {
    if (field === GEOMETRY_FIELD) continue;
    props[field] = coerceLike(props[field], svProps[field]);
  }

  const patch: Partial<GeoJsonFeature> = { type: 'Feature', properties: props };
  if (mine.geometry != null && !keepServerFields.has(GEOMETRY_FIELD)) {
    patch.geometry = mine.geometry as GeoJsonGeometry;
  }
  return patch;
}
