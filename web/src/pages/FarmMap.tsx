import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { MapView } from '../components/MapView';
import { FeatureSidebar } from '../components/FeatureSidebar';
import { LayerToggle } from '../components/LayerToggle';
import { ExportPdfButton } from '../components/ExportPdfButton';
import {
  api,
  type Farm,
  type GeoJsonFeature,
  type GeoJsonFeatureCollection,
} from '../lib/api';
import { queueMutation } from '../lib/db';

const EMPTY: GeoJsonFeatureCollection = { type: 'FeatureCollection', features: [] };

export function FarmMap() {
  const { farmId = '' } = useParams();
  const [farm, setFarm] = useState<Farm | null>(null);
  const [paddocks, setPaddocks] = useState(EMPTY);
  const [polyRuns, setPolyRuns] = useState(EMPTY);
  const [features, setFeatures] = useState(EMPTY);

  const reload = useCallback(async () => {
    const [f, pd, pr, ft] = await Promise.all([
      api.getFarm(farmId),
      api.listPaddocks(farmId),
      api.listPolyRuns(farmId),
      api.listFeatures(farmId),
    ]);
    setFarm(f);
    setPaddocks(pd);
    setPolyRuns(pr);
    setFeatures(ft);
  }, [farmId]);

  useEffect(() => {
    void reload().catch(() => undefined);
  }, [reload]);

  // Geometry type decides the collection: Polygon→paddock, Line→poly run,
  // Point→generic feature. Falls back to the offline queue when the API call
  // fails (no connectivity in the paddock).
  const handleCreate = useCallback(
    async (drawn: GeoJsonFeature) => {
      const geomType = drawn.geometry?.type;
      const base: GeoJsonFeature = {
        type: 'Feature',
        geometry: drawn.geometry,
        properties: {},
      };

      try {
        if (geomType === 'Polygon') {
          base.properties = { name: 'New paddock' };
          await api.createPaddock(farmId, base);
        } else if (geomType === 'LineString') {
          base.properties = { name: 'New poly run' };
          await api.createPolyRun(farmId, base);
        } else {
          base.properties = { type: 'other', name: 'New point' };
          await api.createFeature(farmId, base);
        }
        await reload();
      } catch {
        const endpoint =
          geomType === 'Polygon'
            ? `/farms/${farmId}/paddocks`
            : geomType === 'LineString'
              ? `/farms/${farmId}/poly-runs`
              : `/farms/${farmId}/features`;
        await queueMutation({
          id: crypto.randomUUID(),
          op: 'create',
          method: 'POST',
          endpoint,
          payload: base,
        });
      }
    },
    [farmId, reload],
  );

  return (
    <div className="flex h-full">
      <div className="relative min-w-0 flex-1">
        <MapView onCreate={handleCreate} />
        <div className="absolute left-3 bottom-3 z-10">
          <LayerToggle />
        </div>
        <div className="absolute right-3 top-3 z-10 flex items-center gap-2">
          <span className="rounded bg-slate-900/80 px-3 py-1 text-sm">
            {farm?.name ?? 'Loading…'}
          </span>
          <ExportPdfButton farmId={farmId} />
        </div>
      </div>
      <FeatureSidebar
        paddocks={paddocks}
        polyRuns={polyRuns}
        features={features}
      />
    </div>
  );
}
