// Typed fetch client. All geo endpoints speak GeoJSON.

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  listFarms: () => request<Farm[]>('/farms'),
  getFarm: (id: string) => request<Farm>(`/farms/${id}`),
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

  updatePaddock: (farmId: string, id: string, f: Partial<GeoJsonFeature>) =>
    request<GeoJsonFeature>(`/farms/${farmId}/paddocks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(f),
    }),
  updatePolyRun: (farmId: string, id: string, f: Partial<GeoJsonFeature>) =>
    request<GeoJsonFeature>(`/farms/${farmId}/poly-runs/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(f),
    }),
  updateFeature: (farmId: string, id: string, f: Partial<GeoJsonFeature>) =>
    request<GeoJsonFeature>(`/farms/${farmId}/features/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(f),
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
  /** Absolute URL the api serves the stored image bytes from. */
  photoFileUrl: (id: string) => `${BASE}/photos/file/${id}`,
};
