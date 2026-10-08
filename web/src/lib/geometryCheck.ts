// PT41 — the draw tool refuses shapes the API would refuse, before the name
// dialog opens (and before an offline save queues something that can never
// sync). Same rules as api/src/lib/geojson.ts: a line needs 2 different points,
// a polygon ring needs 3 different corners, must be closed, and must enclose an
// area. Returns null when the geometry is fine, otherwise a sentence for the user.

import type { GeoJsonGeometry } from './api';

type Pos = [number, number];

const key = (p: Pos) => `${p[0]},${p[1]}`;
const distinct = (ps: Pos[]) => new Set(ps.map(key)).size;

function validPos(p: unknown): p is Pos {
  if (!Array.isArray(p) || p.length < 2) return false;
  const [lng, lat] = p as number[];
  return (
    Number.isFinite(lng) && Number.isFinite(lat) && lng! >= -180 && lng! <= 180 && lat! >= -90 && lat! <= 90
  );
}

/** Shoelace about the first corner, so large lng/lat values add no rounding noise. */
function ringArea(r: Pos[]): number {
  const [x0, y0] = r[0]!;
  let a = 0;
  for (let i = 0; i < r.length - 1; i++) {
    a += (r[i]![0] - x0) * (r[i + 1]![1] - y0) - (r[i + 1]![0] - x0) * (r[i]![1] - y0);
  }
  return Math.abs(a / 2);
}

/** Wrap a longitude from a panned-onto world copy (e.g. 510) back into -180..180. */
export function wrapLng(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/**
 * MapLibre lets the user pan onto repeated world copies, and mapbox-gl-draw
 * then reports longitudes beyond ±180. Wrap them before validating or saving.
 * (A shape that truly crosses the antimeridian is not supported.)
 */
export function normaliseLongitudes(g: GeoJsonGeometry): GeoJsonGeometry {
  const fix = (v: unknown): unknown =>
    Array.isArray(v) && typeof v[0] === 'number' ? [wrapLng(v[0] as number), ...v.slice(1)] : Array.isArray(v) ? v.map(fix) : v;
  return { ...g, coordinates: fix(g.coordinates) };
}

export function geometryProblem(g: GeoJsonGeometry | null | undefined): string | null {
  if (!g) return 'Nothing was drawn.';
  if (g.type === 'Point') {
    return validPos(g.coordinates) ? null : 'That point is not a valid position.';
  }
  if (g.type === 'LineString') {
    const ps = g.coordinates as unknown[];
    if (!Array.isArray(ps) || !ps.every(validPos)) return 'That line has an invalid point.';
    return distinct(ps as Pos[]) >= 2 ? null : 'A poly run needs at least 2 different points.';
  }
  if (g.type === 'Polygon') {
    const rings = g.coordinates as unknown[];
    const outer = Array.isArray(rings) ? (rings[0] as unknown[]) : null;
    if (!outer || !Array.isArray(outer) || !outer.every(validPos)) return 'That paddock has an invalid corner.';
    const r = outer as Pos[];
    if (r.length < 4 || distinct(r) < 3) return 'A paddock needs at least 3 different corners.';
    if (key(r[0]!) !== key(r[r.length - 1]!)) return 'A paddock outline must be closed.';
    if (ringArea(r) <= 1e-12) return 'A paddock must enclose an area (its corners are in a line).';
    return null;
  }
  return 'Only points, lines and paddocks can be drawn.';
}
