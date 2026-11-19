import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useParams } from 'react-router-dom';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { MapView } from '../components/MapView';
import {
  FeatureSidebar,
  type SidebarSelection,
} from '../components/FeatureSidebar';
import { LayerToggle } from '../components/LayerToggle';
import { ExportPdfButton } from '../components/ExportPdfButton';
import { PhotoGallery } from '../components/PhotoGallery';
import { DataIoControls } from '../components/DataIoControls';
import { PlaceSearch } from '../components/PlaceSearch';
import {
  FeatureDialog,
  type DrawKind,
  type FeatureDialogResult,
} from '../components/FeatureDialog';
import {
  api,
  ApiError,
  isConflictError,
  type GeoJsonFeature,
  type GeoJsonFeatureCollection,
} from '../lib/api';
import { queueMutation } from '../lib/db';
import { recordConflict } from '../lib/conflictNotice';
import type { ImportPlan } from '../lib/importData';
import { geometryCoords } from '../lib/geo';
import { withClustersOff } from '../lib/clusters';
import { formatArea, formatLength } from '../lib/units';
import { useFarmData } from '../hooks/useFarmData';
import { useDismiss } from '../hooks/useDismiss';
import { useIsPhone } from '../hooks/useIsPhone';
import { forExport } from '../lib/pendingOverlay';
import { geometryProblem, normaliseLongitudes } from '../lib/geometryCheck';
import { describeError, isNetworkError, notify, reportError, shouldQueue } from '../lib/notify';

const EMPTY: GeoJsonFeatureCollection = { type: 'FeatureCollection', features: [] };

const KIND_LABEL: Record<DrawKind, string> = {
  paddock: 'paddock',
  polyRun: 'poly run',
  feature: 'point',
};

/** PT35 — what to tell the user when a write was put in the offline queue. */
function queuedText(what: string, err: unknown): string {
  // A 503 carries our own sentence (PT23: "Writes are disabled: …"), which is the
  // actual fix; "the server is having a problem" would hide it.
  if (err instanceof ApiError && err.status === 503) {
    return `${describeError(`Saving ${what}`, err)} It is kept on this device and will sync once that is fixed.`;
  }
  const why = isNetworkError(err) ? 'No connection' : 'The server is having a problem';
  return `${why}: ${what} is saved on this device and will sync automatically.`;
}

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
  // PT29 — device copy + network + queued edits, in one place.
  const data = useFarmData(farmId);
  const { farm, paddocks, polyRuns, features, reload, loadError } = data;
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
  const [galleryOpen, setGalleryOpen] = useState(false);
  // PT34 — phone layout (below `md`): the feature list is a bottom sheet, closed
  // on every map open so the map is what you see first; the toolbar actions sit
  // behind a "more" menu. Neither state affects the desktop layout.
  const [listOpen, setListOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  // PT34 review — both are phone-only states: crossing the `md` breakpoint (a rotation, a
  // resized window) starts each layout with them closed, so neither reappears on its own later.
  const isPhone = useIsPhone();
  useEffect(() => {
    setListOpen(false);
    setMoreOpen(false);
  }, [isPhone]);
  // PT34 review — the ⋯ menu closes on Escape (focus back on ⋯) and on a press outside it.
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  const moreWrapRef = useRef<HTMLDivElement | null>(null);
  useDismiss(moreOpen, moreWrapRef, (reason) => {
    setMoreOpen(false);
    if (reason === 'escape') moreButtonRef.current?.focus();
  });
  // PT34 review — closing the sheet by Escape or its Close button hands focus back to List.
  // (Picking a row closes it too, but focus then belongs to the edit dialog that opens.)
  const listButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeList = useCallback(() => {
    setListOpen(false);
    listButtonRef.current?.focus();
  }, []);
  // PT34 — the toolbar's measured bottom edge, so the map's control corners start
  // below it however many rows it wraps onto (index.css reads --pt-toolbar-h).
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [toolbarBottom, setToolbarBottom] = useState(56);
  useLayoutEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    const measure = () => setToolbarBottom(Math.ceil(el.offsetTop + el.offsetHeight + 8));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

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

  // Photo markers: offline they simply are not there (PT28 queues new ones);
  // online, a failure is reported.
  useEffect(() => {
    reloadPhotos().catch((err: unknown) => {
      if (navigator.onLine) reportError('Loading photo markers', err);
    });
  }, [reloadPhotos]);

  const retryLoad = useCallback(() => {
    reload().catch((err: unknown) => reportError('Loading this farm', err));
    reloadPhotos().catch((err: unknown) => reportError('Loading photo markers', err));
  }, [reload, reloadPhotos]);

  /** After a successful write: refresh, but a failed refresh must not look like a failed write. */
  const refreshAfterWrite = useCallback(async (): Promise<void> => {
    // Offline the overlay already shows the queued write; nothing to refresh.
    if (navigator.onLine === false) return;
    try {
      await reload();
    } catch (err) {
      reportError('Refreshing the map', err, () => void refreshAfterWrite());
    }
  }, [reload]);

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
    // PT41 — a shape the API would refuse never reaches the dialog or the queue.
    const geometry = drawn.geometry ? normaliseLongitudes(drawn.geometry) : null;
    const problem = geometryProblem(geometry);
    if (problem) {
      notify('error', `${problem} Draw it again.`);
      return;
    }
    const t = geometry?.type;
    const kind: DrawKind =
      t === 'Polygon' ? 'paddock' : t === 'LineString' ? 'polyRun' : 'feature';
    setPending({ kind, geometry });
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

      const what = `the new ${KIND_LABEL[kind]}`;
      try {
        if (kind === 'paddock') await api.createPaddock(farmId, base);
        else if (kind === 'polyRun') await api.createPolyRun(farmId, base);
        else await api.createFeature(farmId, base);
      } catch (err) {
        // PT35 — a refusal (400/404/413/422) is not "offline": queuing it would
        // replay the same refusal forever and block every edit behind it.
        if (!shouldQueue(err)) {
          reportError(`Saving ${what}`, err);
          return;
        }
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
        notify('info', queuedText(what, err));
        return;
      }
      // Outside the try (PT35): a failed refresh after a SUCCESSFUL create used
      // to fall into the catch and queue the create a second time.
      await refreshAfterWrite();
    },
    [pending, farmId, refreshAfterWrite],
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
    // PT34 — on a phone the sheet would cover the edit dialog and the feature.
    setListOpen(false);
  }, []);

  // Edit dialog confirmed: PATCH name/colour (+ type for points), with the
  // same offline-queue fallback as create.
  const handleEditSubmit = useCallback(
    async (r: FeatureDialogResult) => {
      if (!editing) return;
      const { kind, id, version } = editing;
      setEditing(null);

      const patch: Partial<GeoJsonFeature> = {
        properties: propsFor(kind, r),
      };

      const endpoint =
        kind === 'paddock'
          ? `/farms/${farmId}/paddocks/${id}`
          : kind === 'polyRun'
            ? `/farms/${farmId}/poly-runs/${id}`
            : `/farms/${farmId}/features/${id}`;

      try {
        // PT18-fu2 — send the version this edit was based on (PT30: poly
        // runs too, now that they carry one).
        if (kind === 'paddock') await api.updatePaddock(farmId, id, patch, version);
        else if (kind === 'polyRun')
          await api.updatePolyRun(farmId, id, patch, version);
        else await api.updateFeature(farmId, id, patch, version);
      } catch (err) {
        // PT18-fu2 — a conflict is NOT an offline failure. Queuing it would
        // replay the very write the precondition just refused, so it goes to
        // the conflict store (where PT18's merge UI reads from) instead.
        // PT40 — and says so on the map, with a way into the review.
        if (isConflictError(err)) {
          await recordConflict({
            id: crypto.randomUUID(),
            op: 'update',
            endpoint,
            method: 'PATCH',
            status: (err as ApiError).status,
            resolvedAt: Date.now(),
            payload: patch,
          });
          await refreshAfterWrite();
          return;
        }
        const what = `your change to this ${KIND_LABEL[kind]}`;
        if (!shouldQueue(err)) {
          reportError(`Saving ${what}`, err);
          return;
        }
        await queueMutation({
          id: crypto.randomUUID(),
          op: 'update',
          method: 'PATCH',
          endpoint,
          payload: patch,
          baseVersion: version,
        });
        notify('info', queuedText(what, err));
        return;
      }
      await refreshAfterWrite();
    },
    [editing, farmId, refreshAfterWrite],
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
    } catch (err) {
      if (!shouldQueue(err)) {
        reportError(`Deleting this ${KIND_LABEL[kind]}`, err);
        return;
      }
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
      notify('info', queuedText(`the delete of this ${KIND_LABEL[kind]}`, err));
      return;
    }
    await refreshAfterWrite();
  }, [editing, farmId, refreshAfterWrite]);

  // Exports carry what the user sees, minus the internal pending markers (PT29).
  const exportCollections = useMemo(
    () => ({ paddocks: forExport(paddocks), polyRuns: forExport(polyRuns), features: forExport(features) }),
    [paddocks, polyRuns, features],
  );

  const handleExport = useCallback(async () => {
    const map = mapRef.current;
    if (!map) throw new Error('Map not ready');
    // PT32 — jsPDF + html2canvas (~380 KB) load only when Export is pressed.
    const { exportFarmPdf } = await import('../lib/exportPdf');
    // PT32 — the PDF shows every marker, not the on-screen clusters.
    await withClustersOff(map, () => exportFarmPdf({ map, farm, ...exportCollections }));
  }, [farm, exportCollections]);

  const handleImport = useCallback(
    async (plan: ImportPlan) => {
      let created = 0;
      let queued = 0;
      let refused = 0;
      let firstRefusal: unknown = null;

      const tryCreate = async (
        kind: 'paddock' | 'polyRun' | 'feature',
        feature: (typeof plan.paddocks)[number],
      ) => {
        try {
          if (kind === 'paddock') await api.createPaddock(farmId, feature);
          else if (kind === 'polyRun') await api.createPolyRun(farmId, feature);
          else await api.createFeature(farmId, feature);
          created++;
        } catch (err) {
          // PT35 — a refused row is counted and reported, not queued to fail again.
          if (!shouldQueue(err)) {
            refused++;
            firstRefusal ??= err;
            return;
          }
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
            payload: feature,
          });
          queued++;
        }
      };

      for (const f of plan.paddocks) await tryCreate('paddock', f);
      for (const f of plan.polyRuns) await tryCreate('polyRun', f);
      for (const f of plan.features) await tryCreate('feature', f);

      await refreshAfterWrite();
      const refusedText = refused ? `, ${refused} refused by the server` : '';
      const summary = `Import complete: ${created} created, ${queued} queued offline, ${plan.skipped ?? 0} skipped${refusedText}.`;
      if (refused) notify('error', `${summary} ${describeError('First refusal', firstRefusal)}`);
      else notify('success', summary);
    },
    [farmId, refreshAfterWrite],
  );

  return (
    <div className="relative flex h-full">
      <div
        className="pt-map relative min-w-0 flex-1"
        style={{ '--pt-toolbar-h': `${toolbarBottom}px` } as CSSProperties}
      >
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
        {!loadError && data.refreshError && (
          <div
            role="alert"
            data-testid="farm-refresh-error"
            className="absolute bottom-12 left-1/2 z-10 flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 items-center gap-3 rounded-lg border border-red-500/70 bg-slate-900 px-3 py-2 text-xs text-slate-100 shadow-lg"
          >
            <p className="flex-1">{data.refreshError}</p>
            <button onClick={retryLoad} className="min-h-[32px] shrink-0 rounded-md bg-brand px-3 py-1 text-xs text-white max-md:min-h-[44px]">
              Retry
            </button>
          </div>
        )}
        {!loadError && data.source === 'cache' && (
          <div
            role="status"
            data-testid="offline-copy-banner"
            className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-amber-500/90 px-3 py-1 text-xs font-medium text-slate-950 shadow-lg"
          >
            {online ? (data.refreshError ? 'Showing the copy on this device' : 'Showing the copy on this device; refreshing…') : 'Offline'}
            {' · '}
            {data.fetchedAt
              ? `copy from ${new Date(data.fetchedAt).toLocaleString()}`
              : 'copy of unknown age'}
            {data.pendingCount > 0 ? ` · ${data.pendingCount} edit${data.pendingCount === 1 ? '' : 's'} waiting to sync` : ''}
          </div>
        )}
        {loadError && (
          <div
            role="alert"
            data-testid="farm-load-error"
            className="absolute left-1/2 top-16 z-20 flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 items-start gap-3 rounded-lg border border-red-500/70 bg-slate-900 px-4 py-3 text-sm text-slate-100 shadow-xl"
          >
            <span aria-hidden>⚠️</span>
            <p className="flex-1">{loadError}</p>
            <button
              onClick={retryLoad}
              className="min-h-[32px] shrink-0 rounded-md bg-brand px-3 py-1 text-xs text-white max-md:min-h-[44px]"
            >
              Retry
            </button>
          </div>
        )}
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
          measurement={
            editing?.kind === 'polyRun'
              ? formatLength(editing.length_m) || undefined
              : editing?.kind === 'paddock'
                ? formatArea(editing.area_m2) || undefined
                : undefined
          }
          onPhotoUploaded={() => {
            void reloadPhotos();
          }}
          onCancel={() => setEditing(null)}
          onSubmit={handleEditSubmit}
          onDelete={handleEditDelete}
        />
        {/* PT34 — one toolbar row that wraps: search on the left, farm + actions on
            the right. It no longer overlaps (search used to sit centred under the
            actions at 1280 px). Its empty space passes map gestures through. */}
        <div
          ref={toolbarRef}
          data-testid="map-toolbar"
          className="pointer-events-none absolute inset-x-3 top-3 z-10 flex flex-wrap items-start gap-2"
        >
          <div className="pointer-events-auto flex min-w-0 items-start gap-2">
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
                  aria-label="Close search"
                  className="h-9 w-9 shrink-0 rounded-md bg-slate-900/90 text-slate-200 shadow-lg max-md:h-11 max-md:w-11"
                >
                  ✕
                </button>
              </>
            ) : (
              <button
                onClick={() => setSearchOpen(true)}
                title="Search address or place"
                aria-label="Search address or place"
                className="flex h-9 items-center gap-2 rounded-md bg-slate-900/90 px-3 text-sm text-slate-200 shadow-lg max-md:h-11 max-md:min-w-[44px] max-md:justify-center"
              >
                <span aria-hidden>🔍</span>
                <span className="hidden sm:inline">Search</span>
              </button>
            )}
            <span className="max-w-[16rem] self-center truncate rounded bg-slate-900/80 px-3 py-1 text-sm max-md:max-w-[40vw]">
              {farm?.name ?? 'Loading…'}
            </span>
          </div>
          <div ref={moreWrapRef} className="pointer-events-auto relative ml-auto flex min-w-0 items-start justify-end gap-2">
            <button
              ref={moreButtonRef}
              type="button"
              onClick={() => setMoreOpen((v) => !v)}
              aria-expanded={moreOpen}
              aria-controls="map-actions"
              title="More actions"
              aria-label="More actions"
              data-testid="more-actions"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-slate-900/90 text-lg text-slate-200 shadow-lg md:hidden"
            >
              ⋯
            </button>
            {/* Hidden, not unmounted, while the phone menu is closed: DataIoControls
                holds file inputs and import state that must outlive the menu. */}
            <div
              id="map-actions"
              data-testid="map-actions"
              onClick={(e) => {
                if ((e.target as HTMLElement).closest('button')) setMoreOpen(false);
              }}
              className={`flex flex-wrap items-center justify-end gap-2 max-md:absolute max-md:right-0 max-md:top-full max-md:mt-2 max-md:w-56 max-md:flex-col max-md:flex-nowrap max-md:items-stretch max-md:rounded-lg max-md:bg-slate-900/95 max-md:p-2 max-md:shadow-xl ${moreOpen ? '' : 'max-md:hidden'}`}
            >
              <button
                onClick={() => setGalleryOpen(true)}
                title="Photo gallery"
                className="rounded-md bg-slate-900/90 px-3 py-1 text-sm text-slate-200 shadow-lg max-md:min-h-[44px] max-md:text-left"
              >
                🖼 Gallery
              </button>
              <DataIoControls
                farmId={farmId}
                farmName={farm?.name ?? 'farm'}
                paddocks={exportCollections.paddocks}
                polyRuns={exportCollections.polyRuns}
                features={exportCollections.features}
                onImport={handleImport}
                onServerImportComplete={() => void refreshAfterWrite()}
              />
              <ExportPdfButton onExport={handleExport} />
            </div>
          </div>
        </div>
        <div className="absolute bottom-3 left-3 z-10 flex items-end gap-2">
          <LayerToggle />
          <button
            ref={listButtonRef}
            type="button"
            onClick={() => setListOpen(true)}
            aria-expanded={listOpen}
            aria-controls="feature-list"
            data-testid="open-feature-list"
            className="flex h-11 items-center gap-2 rounded-md bg-slate-800/90 px-3 text-sm text-slate-200 shadow-lg md:hidden"
          >
            <span aria-hidden>☰</span> List ({paddocks.features.length + polyRuns.features.length + features.features.length})
          </button>
        </div>
        {galleryOpen && (
          <PhotoGallery
            farmId={farmId}
            onClose={() => setGalleryOpen(false)}
            onChanged={() => void reloadPhotos()}
          />
        )}
      </div>
      <FeatureSidebar
        paddocks={paddocks}
        polyRuns={polyRuns}
        features={features}
        onSelect={handleSelect}
        open={listOpen}
        onClose={closeList}
      />
    </div>
  );
}
