import { create } from 'zustand';
import type { BasemapProvider } from './mapStyle';

export type LayerKey = 'paddocks' | 'polyRuns' | 'features';

const BASEMAP_KEY = 'pt_basemap';

function initialBasemap(): BasemapProvider {
  const v =
    typeof localStorage !== 'undefined'
      ? localStorage.getItem(BASEMAP_KEY)
      : null;
  if (v === 'esri' || v === 'qld' || v === 'mapbox') return v;
  return 'mapbox';
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
