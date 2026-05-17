import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import maplibregl from 'maplibre-gl';
import {
  api,
  type Farm,
  type GeoJsonFeatureCollection,
} from '../lib/api';
import { FEATURE_COLORS, satelliteStyle } from '../lib/mapStyle';

const EMPTY: GeoJsonFeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * Print-only route consumed by Puppeteer. No app chrome. Once the map fires
 * its idle event the root element flips data-map-ready="1" so the PDF
 * renderer knows tiles + layers have painted.
 */
export function PrintFarm() {
  const { farmId = '' } = useParams();
  const mapEl = useRef<HTMLDivElement | null>(null);
  const [farm, setFarm] = useState<Farm | null>(null);
  const [paddocks, setPaddocks] = useState(EMPTY);
  const [polyRuns, setPolyRuns] = useState(EMPTY);
  const [features, setFeatures] = useState(EMPTY);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void (async () => {
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
    })();
  }, [farmId]);

  useEffect(() => {
    if (!mapEl.current || !farm) return;
    const map = new maplibregl.Map({
      container: mapEl.current,
      style: satelliteStyle(),
      center: [134, -25.5],
      zoom: 3.5,
      interactive: false,
      attributionControl: { compact: false },
    });
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    map.on('load', () => {
      const all = [
        ...paddocks.features,
        ...polyRuns.features,
        ...features.features,
      ];

      map.addSource('paddocks', { type: 'geojson', data: paddocks });
      map.addLayer({
        id: 'paddocks-fill',
        type: 'fill',
        source: 'paddocks',
        paint: { 'fill-color': '#22d3ee', 'fill-opacity': 0.25 },
      });
      map.addLayer({
        id: 'paddocks-line',
        type: 'line',
        source: 'paddocks',
        paint: { 'line-color': '#0891b2', 'line-width': 4 },
      });

      map.addSource('poly', { type: 'geojson', data: polyRuns });
      map.addLayer({
        id: 'poly-line',
        type: 'line',
        source: 'poly',
        paint: { 'line-color': '#f97316', 'line-width': 5 },
      });

      map.addSource('pts', { type: 'geojson', data: features });
      map.addLayer({
        id: 'pts-circle',
        type: 'circle',
        source: 'pts',
        paint: {
          'circle-radius': 9,
          'circle-color': [
            'match',
            ['get', 'type'],
            'trough', FEATURE_COLORS.trough!,
            'turkey_nest', FEATURE_COLORS.turkey_nest!,
            'bore', FEATURE_COLORS.bore!,
            'gate', FEATURE_COLORS.gate!,
            'tank', FEATURE_COLORS.tank!,
            FEATURE_COLORS.other!,
          ],
          'circle-stroke-color': '#0f172a',
          'circle-stroke-width': 2,
        },
      });

      const bounds = new maplibregl.LngLatBounds();
      let any = false;
      for (const feat of all) {
        const g = feat.geometry;
        if (!g) continue;
        const coords =
          g.type === 'Point'
            ? [g.coordinates as [number, number]]
            : g.type === 'LineString'
              ? (g.coordinates as [number, number][])
              : (g.coordinates as [number, number][][]).flat();
        for (const c of coords) {
          bounds.extend(c);
          any = true;
        }
      }
      if (any) map.fitBounds(bounds, { padding: 80, duration: 0 });
    });

    map.on('idle', () => setReady(true));
    return () => map.remove();
  }, [farm, paddocks, polyRuns, features]);

  return (
    <div
      data-map-ready={ready ? '1' : '0'}
      className="print-page flex h-screen w-screen flex-col bg-white text-slate-900"
    >
      <style>{`
        @page { size: A3 landscape; margin: 8mm; }
        @media print { .print-page { height: auto; } }
      `}</style>

      <header className="flex items-baseline justify-between border-b-2 border-slate-800 px-2 pb-2">
        <h1 className="text-2xl font-bold">{farm?.name ?? 'Farm map'}</h1>
        <span className="text-sm text-slate-500">
          {new Date().toLocaleDateString()}
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        <div ref={mapEl} className="relative flex-1">
          {/* north arrow */}
          <div className="absolute right-3 top-3 z-10 text-2xl font-bold">
            N&#8593;
          </div>
        </div>

        <aside className="w-64 shrink-0 overflow-hidden border-l border-slate-300 p-3 text-xs">
          <h2 className="mb-2 font-bold">Legend</h2>
          <ul className="mb-4 space-y-1">
            {Object.entries(FEATURE_COLORS).map(([k, c]) => (
              <li key={k} className="flex items-center gap-2">
                <span
                  className="inline-block h-3 w-3 rounded-full"
                  style={{ backgroundColor: c }}
                />
                {k}
              </li>
            ))}
          </ul>
          <h2 className="mb-1 font-bold">Features</h2>
          <table className="w-full">
            <tbody>
              {features.features.map((f) => (
                <tr key={f.id}>
                  <td className="pr-2">{String(f.properties.type ?? '')}</td>
                  <td>{String(f.properties.name ?? '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </aside>
      </div>
    </div>
  );
}
