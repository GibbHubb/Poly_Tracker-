// Typed fetch client. All geo endpoints speak GeoJSON.

import { getReadToken, getWriteToken } from './auth';

const BASE = import.meta.env.VITE_API_BASE || '/api';

export interface Farm {
  id: string;
  name: string;
  owner: string | null;
  created_at: string;
}

export type GeometryType = 'Point' | 'LineString' | 'Polygon';

export interface GeoJsonGeometry {
  type: GeometryType;
  coordinates: unknown;
}

export interface GeoJsonFeature<
  P extends Record<string, unknown> = Record<string, unknown>,
> {
  type: 'Feature';
  id?: string;
  geometry: GeoJsonGeometry | null;
  properties: P;
}

export interface GeoJsonFeatureCollection<
  P extends Record<string, unknown> = Record<string, unknown>,
> {
  type: 'FeatureCollection';
  features: GeoJsonFeature<P>[];
}

export interface Photo {
  id: string;
  feature_type: string | null;
  feature_id: string | null;
  path: string;
  taken_at: string | null;
  // PostGIS numeric columns serialise as strings.
  lat: string | null;
  lng: string | null;
}

export interface ImportReportEntry {
  index: number;
  kind?: 'paddock' | 'polyRun' | 'feature';
  status: 'inserted' | 'skipped' | 'error';
  id?: string;
  error?: string;
}

export interface ImportGeojsonReport {
  mode: 'partial' | 'all-or-nothing';
  committed: boolean;
  inserted: number;
  skipped: number;
  errored: number;
  report: ImportReportEntry[];
}

/**
 * PT18-fu2 — an HTTP failure, carrying its status.
 *
 * `request` used to throw a bare Error whose only clue was the status
 * embedded in the message, so callers could not tell a 412 conflict from a
 * network drop. That mattered the moment the API started emitting 412: the
 * offline-queue fallback catches everything, so a conflict would have been
 * mistaken for "offline", queued, and replayed — overwriting exactly the
 * write the precondition existed to protect.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`API ${status}: ${body}`);
    this.name = 'ApiError';
  }
}

/** True for the conflict statuses the replay/merge path handles. */
export function isConflictError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 409 || err.status === 412);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const isMutation = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
  // Mutations use the write token; GETs use the read token, falling back to
  // the write token (write ⊇ read). Header attached only when a token exists.
  const token = isMutation ? getWriteToken() : getReadToken() ?? getWriteToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(res.status, text);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  listFarms: () => request<Farm[]>('/farms'),
  getFarm: (id: string) => request<Farm>(`/farms/${id}`),
  /** GET a single record by its full relative path, e.g. /farms/x/paddocks/y.
   *  Used by the conflict-merge flow to fetch current server state. */
  getByPath: (path: string) => request<GeoJsonFeature>(path),
  createFarm: (body: { name: string; owner?: string | null }) =>
    request<Farm>('/farms', { method: 'POST', body: JSON.stringify(body) }),

  listPaddocks: (farmId: string) =>
    request<GeoJsonFeatureCollection>(`/farms/${farmId}/paddocks`),
  listPolyRuns: (farmId: string) =>
    request<GeoJsonFeatureCollection>(`/farms/${farmId}/poly-runs`),
  listFeatures: (farmId: string) =>
    request<GeoJsonFeatureCollection>(`/farms/${farmId}/features`),

  createPaddock: (farmId: string, f: GeoJsonFeature) =>
    request<GeoJsonFeature>(`/farms/${farmId}/paddocks`, {
      method: 'POST',
      body: JSON.stringify(f),
    }),
  createPolyRun: (farmId: string, f: GeoJsonFeature) =>
    request<GeoJsonFeature>(`/farms/${farmId}/poly-runs`, {
      method: 'POST',
      body: JSON.stringify(f),
    }),
  createFeature: (farmId: string, f: GeoJsonFeature) =>
    request<GeoJsonFeature>(`/farms/${farmId}/features`, {
      method: 'POST',
      body: JSON.stringify(f),
    }),

  // PT18-fu2 — `baseVersion` becomes If-Match, so a stale edit gets a 412
  // rather than silently clobbering a newer one. Omit it to keep the old
  // last-write-wins behaviour.
  updatePaddock: (
    farmId: string,
    id: string,
    f: Partial<GeoJsonFeature>,
    baseVersion?: number | null,
  ) =>
    request<GeoJsonFeature>(`/farms/${farmId}/paddocks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(f),
      ...(baseVersion != null
        ? { headers: { 'If-Match': `"${baseVersion}"` } }
        : {}),
    }),
  updatePolyRun: (farmId: string, id: string, f: Partial<GeoJsonFeature>) =>
    request<GeoJsonFeature>(`/farms/${farmId}/poly-runs/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(f),
    }),
  // PT18-fu2 — `baseVersion` becomes If-Match, so a stale edit gets a 412
  // rather than silently clobbering a newer one. Omit it to keep the old
  // last-write-wins behaviour.
  updateFeature: (
    farmId: string,
    id: string,
    f: Partial<GeoJsonFeature>,
    baseVersion?: number | null,
  ) =>
    request<GeoJsonFeature>(`/farms/${farmId}/features/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(f),
      ...(baseVersion != null
        ? { headers: { 'If-Match': `"${baseVersion}"` } }
        : {}),
    }),

  deletePaddock: (farmId: string, id: string) =>
    request<void>(`/farms/${farmId}/paddocks/${id}`, { method: 'DELETE' }),
  deletePolyRun: (farmId: string, id: string) =>
    request<void>(`/farms/${farmId}/poly-runs/${id}`, { method: 'DELETE' }),
  deleteFeature: (farmId: string, id: string) =>
    request<void>(`/farms/${farmId}/features/${id}`, { method: 'DELETE' }),

  listPhotos: (opts?: { featureId?: string; farmId?: string }) => {
    const qs = opts?.featureId
      ? `?feature_id=${opts.featureId}`
      : opts?.farmId
        ? `?farm_id=${opts.farmId}`
        : '';
    return request<Photo[]>(`/photos${qs}`);
  },
  deletePhoto: (id: string) =>
    request<void>(`/photos/${id}`, { method: 'DELETE' }),
  /** Absolute URL the api serves the stored image bytes from. */
  photoFileUrl: (id: string) => `${BASE}/photos/file/${id}`,

  /**
   * Server-side bulk import (PT19): POST the raw GeoJSON file to
   * /api/import/geojson as multipart/form-data. Bypasses request() because
   * FormData needs the browser to set its own multipart boundary — a manual
   * Content-Type header would break the upload.
   *
   * Default mode is all-or-nothing: the first bad feature rolls back the
   * whole batch and the API answers 422 with a still-valid report body
   * (committed: false), so 422 is treated as a normal response here rather
   * than thrown as an error.
   */
  importGeojsonServer: async (
    file: File,
    farmId: string,
    opts?: { partial?: boolean },
  ): Promise<ImportGeojsonReport> => {
    const form = new FormData();
    form.append('file', file);
    form.append('farm_id', farmId);
    const qs = opts?.partial ? '?partial=true' : '';
    const token = getWriteToken();
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${BASE}/import/geojson${qs}`, {
      method: 'POST',
      headers,
      body: form,
    });
    if (!res.ok && res.status !== 422) {
      const text = await res.text();
      throw new Error(`API ${res.status}: ${text}`);
    }
    return (await res.json()) as ImportGeojsonReport;
  },
};
