// Formatting helpers for derived geometry measurements (PT6).
// PostGIS `geography` ST_Length/ST_Area serialise as strings over JSON, so
// every helper coerces defensively and returns '' for null/NaN inputs.

function toNum(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Ground length in metres → `"840 m"` below 1 km, `"1.24 km"` (2 dp) at/above
 * 1 km. Returns `''` when the value is null/unknown (e.g. geometry-less row).
 */
export function formatLength(meters: unknown): string {
  const m = toNum(meters);
  if (m === null) return '';
  if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
  return `${Math.round(m)} m`;
}

/**
 * Area in square metres → `"850 m²"` below 1 ha, `"12.40 ha"` (2 dp) at/above
 * 1 ha (1 ha = 10 000 m²). Returns `''` when the value is null/unknown.
 */
export function formatArea(squareMeters: unknown): string {
  const m2 = toNum(squareMeters);
  if (m2 === null) return '';
  if (m2 >= 10000) return `${(m2 / 10000).toFixed(2)} ha`;
  return `${Math.round(m2)} m²`;
}
