import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { MapView } from '../components/MapView';
import {
  FeatureSidebar,
  type SidebarSelection,
} from '../components/FeatureSidebar';
import { LayerToggle } from '../components/LayerToggle';
import { ExportPdfButton } from '../components/ExportPdfButton';
import { PlaceSearch } from '../components/PlaceSearch';
import {
  FeatureDialog,
  type DrawKind,
  type FeatureDialogResult,
} from '../components/FeatureDialog';
import {
  api,
  type Farm,
  type GeoJsonFeature,
  type GeoJsonFeatureCollection,
} from '../lib/api';
import { queueMutation } from '../lib/db';
import { geometryCoords } from '../lib/geo';
import { exportFarmPdf } from '../lib/exportPdf';

const EMPTY: GeoJsonFeatureCollection = { type: 'FeatureCollection', features: [] };

/** Build the GeoJSON properties payload for a given kind from the dialog. */
function propsFor(
  kind: DrawKind,
  r: FeatureDialogResult,
): Record<string, unknown> {
  const p: Record<string, unknown> = {
    name: r.name,
    color: r.color,
    notes: r.notes,
  };
  if (kind === 'feature') p.type = r.type;
  if (kind === 'polyRun') {
    p.diameter_mm = r.diameter_mm;
    p.depth_m = r.depth_m;
    p.material = r.material;
    p.installed_date = r.installed_date;
  }
  return p;
}

export function FarmMap() {
  const { farmId = '' } = useParams();
  const [farm, setFarm] = useState<Farm | null>(null);
  const [paddocks, setPaddocks] = useState(EMPTY);
  const [polyRuns, setPolyRuns] = useState(EMPTY);
  const [features, setFeatures] = useState(EMPTY);
  const [photos, setPhotos] = useState(EMPTY);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [mapReady, setMapReady] = useState(false);
  // One-shot: fit the map to the farm's saved geometry on first load.
  const didFitRef = useRef(false);
  // Geometry awaiting name/colour from the dialog.
  const [pending, setPending] = useState<{
    kind: DrawKind;
    geometry: GeoJsonFeature['geometry'];
  } | null>(null);
  // Existing feature selected from the sidebar for editing.
  const [editing, setEditing] = useState<SidebarSelection | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);

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

  // Geotagged photos → Point features (precompute the file URL so MapView
  // stays API-agnostic). The photos API isn't farm-scoped, so this lists all
  // photos with a fix for THIS farm (scoped server-side via features join).
  const reloadPhotos = useCallback(async () => {
    const rows = await api.listPhotos({ farmId });
    setPhotos({
      type: 'FeatureCollection',
      features: rows
        .filter(
          (p) =>
            p.lat != null &&
            p.lng != null &&
            p.lat !== '' &&
            p.lng !== '' &&
            Number.isFinite(Number(p.lat)) &&
            Number.isFinite(Number(p.lng)),
        )
        .map((p) => ({
          type: 'Feature',
          id: p.id,
          geometry: {
            type: 'Point',
            coordinates: [Number(p.lng), Number(p.lat)],
          },
          properties: {
            id: p.id,
            url: api.photoFileUrl(p.id),
            taken_at: p.taken_at,
          },
        })),
    });
  }, [farmId]);

  useEffect(() => {
    void reload().catch(() => undefined);
    void reloadPhotos().catch(() => undefined);
  }, [reload, reloadPhotos]);

  // Once the map is ready and the farm's geometry has loaded, fit the view
  // to it (one-shot — don't fight the user's later pan/zoom).
  useEffect(() => {
    if (!mapReady || didFitRef.current) return;
    const map = mapRef.current;
    if (!map) return;
    const coords = [
      ...paddocks.features,
      ...polyRuns.features,
      ...features.features,
    ].flatMap((f) => geometryCoords(f.geometry));
    if (coords.length === 0) return;
    let w = 180,
      s = 90,
      e = -180,
      n = -90;
    for (const [lng, lat] of coords) {
      w = Math.min(w, lng);
      e = Math.max(e, lng);
      s = Math.min(s, lat);
      n = Math.max(n, lat);
    }
    didFitRef.current = true;
    if (w === e && s === n) {
      map.flyTo({ center: [w, s], zoom: 16 });
    } else {
      map.fitBounds(
        [
          [w, s],
          [e, n],
        ],
        { padding: 80, maxZoom: 17, duration: 600 },
      );
    }
  }, [mapReady, paddocks, polyRuns, features]);

  // Geometry type decides the collection: Polygon→paddock, Line→poly run,
  // Point→generic feature. The drawn shape opens the name/colour dialog.
  const handleCreate = useCallback((drawn: GeoJsonFeature) => {
    const t = drawn.geometry?.type;
    const kind: DrawKind =
      t === 'Polygon' ? 'paddock' : t === 'LineString' ? 'polyRun' : 'feature';
    setPending({ kind, geometry: drawn.geometry });
  }, []);

  // Dialog confirmed: persist with name/colour (+ type for points), falling
  // back to the offline queue when the API call fails (no paddock signal).
  const handleDialogSubmit = useCallback(
    async (r: FeatureDialogResult) => {
      if (!pending) return;
      const { kind, geometry } = pending;
      setPending(null);

      const base: GeoJsonFeature = {
        type: 'Feature',
        geometry,
        properties: propsFor(kind, r),
      };

      try {
        if (kind === 'paddock') await api.createPaddock(farmId, base);
        else if (kind === 'polyRun') await api.createPolyRun(farmId, base);
        else await api.createFeature(farmId, base);
        await reload();
      } catch {
        const endpoint =
          kind === 'paddock'
            ? `/farms/${farmId}/paddocks`
            : kind === 'polyRun'
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
    [pending, farmId, reload],
  );

  // Sidebar click: fly the map to the feature, then open the edit dialog.
  const handleSelect = useCallback((sel: SidebarSelection) => {
    const map = mapRef.current;
    const coords = geometryCoords(sel.geometry);
    if (map && coords.length > 0) {
      if (coords.length === 1 && coords[0]) {
        map.flyTo({ center: coords[0], zoom: 16 });
      } else {
        let w = 180,
          s = 90,
          e = -180,
          n = -90;
        for (const [lng, lat] of coords) {
          w = Math.min(w, lng);
          e = Math.max(e, lng);
          s = Math.min(s, lat);
          n = Math.max(n, lat);
        }
        map.fitBounds(
          [
            [w, s],
            [e, n],
          ],
          { padding: 80, maxZoom: 17, duration: 600 },
        );
      }
    }
    setEditing(sel);
  }, []);

  // Edit dialog confirmed: PATCH name/colour (+ type for points), with the
  // same offline-queue fallback as create.
  const handleEditSubmit = useCallback(
    async (r: FeatureDialogResult) => {
      if (!editing) return;
      const { kind, id } = editing;
      setEditing(null);

      const patch: Partial<GeoJsonFeature> = {
        properties: propsFor(kind, r),
      };

      try {
        if (kind === 'paddock') await api.updatePaddock(farmId, id, patch);
        else if (kind === 'polyRun')
          await api.updatePolyRun(farmId, id, patch);
        else await api.updateFeature(farmId, id, patch);
        await reload();
      } catch {
        const endpoint =
          kind === 'paddock'
            ? `/farms/${farmId}/paddocks/${id}`
            : kind === 'polyRun'
              ? `/farms/${farmId}/poly-runs/${id}`
              : `/farms/${farmId}/features/${id}`;
        await queueMutation({
          id: crypto.randomUUID(),
          op: 'update',
          method: 'PATCH',
          endpoint,
          payload: patch,
        });
      }
    },
    [editing, farmId, reload],
  );

  // Delete the selected feature (offline-queued if the API is unreachable).
  const handleEditDelete = useCallback(async () => {
    if (!editing) return;
    const { kind, id } = editing;
    setEditing(null);
    try {
      if (kind === 'paddock') await api.deletePaddock(farmId, id);
      else if (kind === 'polyRun') await api.deletePolyRun(farmId, id);
      else await api.deleteFeature(farmId, id);
      await reload();
    } catch {
      const endpoint =
        kind === 'paddock'
          ? `/farms/${farmId}/paddocks/${id}`
          : kind === 'polyRun'
            ? `/farms/${farmId}/poly-runs/${id}`
            : `/farms/${farmId}/features/${id}`;
      await queueMutation({
        id: crypto.randomUUID(),
        op: 'delete',
        method: 'DELETE',
        endpoint,
        payload: null,
      });
    }
  }, [editing, farmId, reload]);

  const handleExport = useCallback(async () => {
    const map = mapRef.current;
    if (!map) throw new Error('Map not ready');
    await exportFarmPdf({ map, farm, paddocks, polyRuns, features });
  }, [farm, paddocks, polyRuns, features]);

  return (
    <div className="flex h-full">
      <div className="relative min-w-0 flex-1">
        <MapView
          paddocks={paddocks}
          polyRuns={polyRuns}
          features={features}
          photos={photos}
          onCreate={handleCreate}
          onReady={(m) => {
            mapRef.current = m;
            setMapReady(true);
          }}
        />
        <FeatureDialog
          kind={pending?.kind ?? null}
          onCancel={() => setPending(null)}
          onSubmit={handleDialogSubmit}
        />
        <FeatureDialog
          kind={editing?.kind ?? null}
          mode="edit"
          initial={
            editing
              ? {
                  name: editing.name,
                  color: editing.color,
                  type: editing.type,
                  notes: editing.notes,
                  diameter_mm: editing.diameter_mm,
                  depth_m: editing.depth_m,
                  material: editing.material,
                  installed_date: editing.installed_date,
                }
              : undefined
          }
          featureId={editing?.id}
          onPhotoUploaded={() => {
            void reloadPhotos();
          }}
          onCancel={() => setEditing(null)}
          onSubmit={handleEditSubmit}
          onDelete={handleEditDelete}
        />
        <div className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-start gap-2">
          {searchOpen ? (
            <>
              <PlaceSearch
                onSelect={(hit) => {
                  const map = mapRef.current;
                  if (map) {
                    if (hit.bbox) {
                      map.fitBounds(hit.bbox, { padding: 60, maxZoom: 16 });
                    } else {
                      map.flyTo({ center: hit.center, zoom: 15 });
                    }
                  }
                  setSearchOpen(false);
                }}
              />
              <button
                onClick={() => setSearchOpen(false)}
                title="Close search"
                className="h-9 w-9 rounded-md bg-slate-900/90 text-slate-200 shadow-lg"
              >
                ✕
              </button>
            </>
          ) : (
            <button
              onClick={() => setSearchOpen(true)}
              title="Search address or place"
              className="flex h-9 items-center gap-2 rounded-md bg-slate-900/90 px-3 text-sm text-slate-200 shadow-lg"
            >
              <span aria-hidden>🔍</span>
              <span className="hidden sm:inline">Search</span>
            </button>
          )}
        </div>
        <div className="absolute left-3 bottom-3 z-10">
          <LayerToggle />
        </div>
        <div className="absolute right-3 top-3 z-10 flex items-center gap-2">
          <span className="rounded bg-slate-900/80 px-3 py-1 text-sm">
            {farm?.name ?? 'Loading…'}
          </span>
          <ExportPdfButton onExport={handleExport} />
        </div>
      </div>
      <FeatureSidebar
        paddocks={paddocks}
        polyRuns={polyRuns}
        features={features}
        onSelect={handleSelect}
      />
    </div>
  );
}
