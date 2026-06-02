import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { BasemapProvider } from '../lib/mapStyle';
import {
  canDownload,
  clearArea,
  downloadArea,
  estimateArea,
  listAreas,
  TILE_CAP,
  type AreaBounds,
  type DownloadProgress,
} from '../lib/tileCache';
import type { OfflineArea } from '../lib/db';

interface Props {
  map: MapLibreMap | null;
  provider: BasemapProvider;
  onClose: () => void;
}

const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const MAX_DEPTH = 4;

/** Offline tile pre-download + manage panel (PT11). */
export function OfflineAreas({ map, provider, onClose }: Props) {
  const [depth, setDepth] = useState(2);
  const [areas, setAreas] = useState<OfflineArea[]>([]);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void listAreas().then(setAreas);
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const allowed = canDownload(provider);

  // Plan the download for the current viewport + chosen depth.
  const plan = useMemo(() => {
    if (!map) return null;
    const b = map.getBounds();
    const zMin = Math.floor(map.getZoom());
    const zMax = Math.min(zMin + depth, 22);
    const bounds: AreaBounds = {
      w: b.getWest(),
      s: b.getSouth(),
      e: b.getEast(),
      n: b.getNorth(),
    };
    return { bounds, zMin, zMax, est: estimateArea(bounds, zMin, zMax) };
    // Re-plan whenever the panel opens or depth changes; the map ref is stable.
  }, [map, depth]);

  const start = useCallback(async () => {
    if (!plan) return;
    setError(null);
    setProgress({ done: 0, total: plan.est.tileCount });
    try {
      await downloadArea({
        name: `Area · ${new Date().toLocaleString()}`,
        provider,
        bounds: plan.bounds,
        zMin: plan.zMin,
        zMax: plan.zMax,
        onProgress: setProgress,
      });
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Download failed.');
    } finally {
      setProgress(null);
    }
  }, [plan, provider, refresh]);

  const downloading = progress !== null;
  const blocked = !allowed || !plan || plan.est.overCap;

  return (
    <div className="absolute right-3 top-16 z-30 w-72 rounded-lg bg-slate-800/95 p-3 text-sm text-slate-200 shadow-xl">
      <div className="mb-2 flex items-center justify-between">
        <p className="font-medium text-slate-100">Offline imagery</p>
        <button onClick={onClose} title="Close" className="text-slate-400">
          ✕
        </button>
      </div>

      {!allowed ? (
        <p className="text-slate-400">
          Offline download isn't available for <b>{provider}</b> (provider terms).
          Switch to <b>Esri</b> or <b>QLD</b> imagery to pre-download this area.
        </p>
      ) : (
        <>
          <label className="mb-1 block text-slate-300">
            Zoom depth: +{depth} level{depth === 1 ? '' : 's'}
          </label>
          <input
            type="range"
            min={1}
            max={MAX_DEPTH}
            value={depth}
            onChange={(e) => setDepth(Number(e.target.value))}
            disabled={downloading}
            className="mb-2 w-full"
          />
          {plan && (
            <p className="mb-2 text-xs text-slate-400">
              Zooms {plan.zMin}–{plan.zMax} · {plan.est.tileCount} tiles · ~
              {mb(plan.est.bytes)}
              {plan.est.overCap && (
                <span className="block text-amber-400">
                  Over the {TILE_CAP}-tile cap — zoom in or reduce depth.
                </span>
              )}
            </p>
          )}

          {downloading && progress ? (
            <div className="mb-2">
              <div className="h-2 w-full overflow-hidden rounded bg-slate-700">
                <div
                  className="h-full bg-brand"
                  style={{
                    width: `${
                      progress.total
                        ? Math.round((progress.done / progress.total) * 100)
                        : 0
                    }%`,
                  }}
                />
              </div>
              <p className="mt-1 text-xs text-slate-400">
                {progress.done} / {progress.total} tiles
              </p>
            </div>
          ) : (
            <button
              onClick={start}
              disabled={blocked}
              className="mb-2 w-full rounded-md bg-brand px-3 py-1.5 font-medium text-white disabled:opacity-50"
            >
              Download this area
            </button>
          )}
        </>
      )}

      {error && <p className="mb-2 text-xs text-red-300">{error}</p>}

      {areas.length > 0 && (
        <div className="mt-2 border-t border-slate-700 pt-2">
          <p className="mb-1 font-medium text-slate-300">Saved areas</p>
          <ul className="space-y-1">
            {areas.map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between gap-2"
              >
                <span className="truncate text-xs text-slate-400">
                  {a.provider} · z{a.zMin}–{a.zMax} · {a.tileCount} ·{' '}
                  {mb(a.bytes)}
                </span>
                <button
                  onClick={() => void clearArea(a).then(refresh)}
                  className="shrink-0 rounded bg-slate-700 px-2 py-0.5 text-xs"
                >
                  Clear
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
