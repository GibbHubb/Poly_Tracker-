import { create } from 'zustand';

export type LayerKey = 'paddocks' | 'polyRuns' | 'features';

interface AppState {
  visibleLayers: Record<LayerKey, boolean>;
  toggleLayer: (key: LayerKey) => void;
  selectedFeatureId: string | null;
  selectFeature: (id: string | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
  visibleLayers: { paddocks: true, polyRuns: true, features: true },
  toggleLayer: (key) =>
    set((s) => ({
      visibleLayers: { ...s.visibleLayers, [key]: !s.visibleLayers[key] },
    })),
  selectedFeatureId: null,
  selectFeature: (id) => set({ selectedFeatureId: id }),
}));
