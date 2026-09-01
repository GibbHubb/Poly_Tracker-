import { create } from 'zustand';
import { hasMapboxToken, type BasemapProvider } from './mapStyle';

export type LayerKey = 'paddocks' | 'polyRuns' | 'features';

const BASEMAP_KEY = 'pt_basemap';

function initialBasemap(): BasemapProvider {
  const v =
    typeof localStorage !== 'undefined'
      ? localStorage.getItem(BASEMAP_KEY)
      : null;
  if (v === 'esri' || v === 'qld' || v === 'mapbox') return v;
  // PT25 — Mapbox is the better imagery and stays the default WHEN there is a
  // token to fetch it with. Without one the app still asked Mapbox, with an
  // empty access_token, so every tile 401'd and you got a grey rectangle with
  // no explanation — which reads as "the app is broken" rather than "a key is
  // missing", and that is the expensive diagnosis. Esri needs no token.
  return hasMapboxToken() ? 'mapbox' : 'esri';
}

interface AppState {
  visibleLayers: Record<LayerKey, boolean>;
  toggleLayer: (key: LayerKey) => void;
  // PT8: master on/off for on-map name/type labels (spans all three layers).
  labels: boolean;
  toggleLabels: () => void;
  selectedFeatureId: string | null;
  selectFeature: (id: string | null) => void;
  basemap: BasemapProvider;
  setBasemap: (b: BasemapProvider) => void;
}

export const useAppStore = create<AppState>((set) => ({
  visibleLayers: { paddocks: true, polyRuns: true, features: true },
  toggleLayer: (key) =>
    set((s) => ({
      visibleLayers: { ...s.visibleLayers, [key]: !s.visibleLayers[key] },
    })),
  labels: true,
  toggleLabels: () => set((s) => ({ labels: !s.labels })),
  selectedFeatureId: null,
  selectFeature: (id) => set({ selectedFeatureId: id }),
  basemap: initialBasemap(),
  setBasemap: (b) => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(BASEMAP_KEY, b);
    set({ basemap: b });
  },
}));
