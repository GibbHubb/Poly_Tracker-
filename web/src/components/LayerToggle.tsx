import { useAppStore, type LayerKey } from '../lib/store';
import { hasMapboxToken } from '../lib/mapStyle';  // PT25

const LABELS: Record<LayerKey, string> = {
  paddocks: 'Paddocks',
  polyRuns: 'Poly runs',
  features: 'Points',
};

export function LayerToggle() {
  const visible = useAppStore((s) => s.visibleLayers);
  const toggle = useAppStore((s) => s.toggleLayer);
  const labels = useAppStore((s) => s.labels);
  const toggleLabels = useAppStore((s) => s.toggleLabels);
  const basemap = useAppStore((s) => s.basemap);
  const setBasemap = useAppStore((s) => s.setBasemap);

  return (
    <div className="rounded-lg bg-slate-800/90 p-3 text-sm shadow-lg">
      <p className="mb-2 font-medium text-slate-300">Layers</p>
      {(Object.keys(LABELS) as LayerKey[]).map((key) => (
        <label key={key} className="flex items-center gap-2 py-1">
          <input
            type="checkbox"
            checked={visible[key]}
            onChange={() => toggle(key)}
          />
          {LABELS[key]}
        </label>
      ))}
      <label className="mt-1 flex items-center gap-2 border-t border-slate-700 py-1 pt-2">
        <input type="checkbox" checked={labels} onChange={toggleLabels} />
        Labels
      </label>

      <p className="mb-1 mt-3 font-medium text-slate-300">Imagery</p>
      <div className="flex overflow-hidden rounded-md border border-slate-600">
        {/* PT25 — a provider that cannot render says so, instead of handing
            back a grey rectangle. */}
        {(['mapbox', 'esri', 'qld'] as const).map((p) => (
          <button
            key={p}
            onClick={() => setBasemap(p)}
            disabled={p === 'mapbox' && !hasMapboxToken()}
            title={
              p === 'mapbox' && !hasMapboxToken()
                ? 'No VITE_MAPBOX_TOKEN on this deployment — Mapbox tiles would come back empty'
                : undefined
            }
            className={`flex-1 px-2 py-1 capitalize ${
              basemap === p
                ? 'bg-brand text-white'
                : 'bg-slate-900 text-slate-300'
            } disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            {p === 'qld' ? 'QLD' : p}
          </button>
        ))}
      </div>
    </div>
  );
}
