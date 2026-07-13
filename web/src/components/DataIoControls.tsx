import { useRef, useState } from 'react';
import { api, type GeoJsonFeatureCollection, type ImportGeojsonReport } from '../lib/api';
import { mergeFarmGeoJson, pointsToCsv, downloadBlob } from '../lib/exportData';
import { parseImport, buildImportPlan, type ImportPlan } from '../lib/importData';

interface Props {
  farmId: string;
  farmName: string;
  paddocks: GeoJsonFeatureCollection;
  polyRuns: GeoJsonFeatureCollection;
  features: GeoJsonFeatureCollection;
  onImport: (plan: ImportPlan) => Promise<void>;
  /** Called after a committed server-side import so the parent can reload farm data. */
  onServerImportComplete?: () => void;
}

export function DataIoControls({
  farmId,
  farmName,
  paddocks,
  polyRuns,
  features,
  onImport,
  onServerImportComplete,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const serverFileRef = useRef<HTMLInputElement>(null);
  const [allowPartial, setAllowPartial] = useState(false);
  const [serverImporting, setServerImporting] = useState(false);
  const [serverReport, setServerReport] = useState<ImportGeojsonReport | null>(null);

  const handleExportGeoJson = () => {
    const { geojson, filename } = mergeFarmGeoJson(farmName, paddocks, polyRuns, features);
    downloadBlob(filename, 'application/geo+json', geojson);
  };

  const handleExportCsv = () => {
    const { csv, filename } = pointsToCsv(farmName, features);
    downloadBlob(filename, 'text/csv;charset=utf-8;', csv);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const fc = parseImport(reader.result as string);
        setPlan(buildImportPlan(fc));
        setImportError(null);
      } catch (err) {
        setImportError(err instanceof Error ? err.message : 'Invalid file.');
        alert(err instanceof Error ? err.message : 'Invalid file.');
      }
    };
    reader.readAsText(file);
  };

  const handleServerFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setServerImporting(true);
    try {
      const report = await api.importGeojsonServer(file, farmId, { partial: allowPartial });
      setServerReport(report);
      if (report.committed) onServerImportComplete?.();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Server import failed.');
    } finally {
      setServerImporting(false);
    }
  };

  const handleConfirm = async () => {
    if (!plan) return;
    setImporting(true);
    try {
      await onImport(plan);
      setPlan(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Import failed.');
    } finally {
      setImporting(false);
    }
  };

  const btnClass =
    'rounded-md bg-slate-900/90 px-3 py-1 text-sm text-slate-200 shadow-lg hover:bg-slate-700/90';

  return (
    <>
      <button onClick={handleExportGeoJson} className={btnClass} title="Export all farm data as GeoJSON">
        ↓ GeoJSON
      </button>
      <button onClick={handleExportCsv} className={btnClass} title="Export points as CSV">
        ↓ CSV
      </button>
      <button onClick={() => fileRef.current?.click()} className={btnClass} title="Import GeoJSON">
        ↑ Import
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".geojson,.json"
        className="hidden"
        onChange={handleFileChange}
      />

      <label
        className="flex items-center gap-1 rounded-md bg-slate-900/90 px-2 py-1 text-xs text-slate-300 shadow-lg"
        title="Commit every valid feature even if some fail (otherwise the whole batch rolls back on the first error)"
      >
        <input
          type="checkbox"
          checked={allowPartial}
          onChange={(e) => setAllowPartial(e.target.checked)}
        />
        Allow partial
      </label>
      <button
        onClick={() => serverFileRef.current?.click()}
        disabled={serverImporting}
        className={btnClass}
        title="Bulk-import a GeoJSON FeatureCollection via the server (single transaction)"
      >
        {serverImporting ? 'Uploading…' : '↑ Server import'}
      </button>
      <input
        ref={serverFileRef}
        type="file"
        accept=".geojson,.json"
        className="hidden"
        onChange={handleServerFileChange}
      />

      {serverReport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="max-h-[80vh] w-96 overflow-y-auto rounded-xl bg-slate-900 p-6 text-slate-200 shadow-2xl">
            <h2 className="mb-1 text-lg font-semibold">Server import report</h2>
            <p className="mb-4 text-xs text-slate-500">
              Mode: {serverReport.mode} ·{' '}
              {serverReport.committed ? 'committed' : 'rolled back (no changes saved)'}
            </p>
            <ul className="mb-4 space-y-1 text-sm">
              <li>Inserted: <strong>{serverReport.inserted}</strong></li>
              <li>Skipped: <strong>{serverReport.skipped}</strong></li>
              <li>Errored: <strong>{serverReport.errored}</strong></li>
            </ul>
            {serverReport.report.some((r) => r.status !== 'inserted') && (
              <div className="mb-4">
                <p className="mb-1 text-xs text-slate-400">Skipped / errored features:</p>
                <ul className="max-h-40 space-y-1 overflow-y-auto text-xs">
                  {serverReport.report
                    .filter((r) => r.status !== 'inserted')
                    .map((r) => (
                      <li
                        key={r.index}
                        className={r.status === 'error' ? 'text-red-400' : 'text-amber-400'}
                      >
                        #{r.index}
                        {r.kind ? ` (${r.kind})` : ''}: {r.status}
                        {r.error ? ` — ${r.error}` : ''}
                      </li>
                    ))}
                </ul>
              </div>
            )}
            <button
              onClick={() => setServerReport(null)}
              className="w-full rounded-md bg-slate-700 py-2 text-sm text-slate-200"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {plan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-80 rounded-xl bg-slate-900 p-6 text-slate-200 shadow-2xl">
            <h2 className="mb-4 text-lg font-semibold">Import preview</h2>
            <p className="mb-1 text-sm text-slate-400">Geometry type routing:</p>
            <ul className="mb-4 space-y-1 text-sm">
              <li>Paddocks (Polygon): <strong>{plan.paddocks.length}</strong></li>
              <li>Poly runs (LineString): <strong>{plan.polyRuns.length}</strong></li>
              <li>Points: <strong>{plan.features.length}</strong></li>
              {plan.skipped > 0 && (
                <li className="text-amber-400">Skipped (unsupported geometry): <strong>{plan.skipped}</strong></li>
              )}
            </ul>
            <p className="mb-4 text-xs text-slate-500">
              Features are routed by shape. Each import creates new entries — re-importing will create duplicates.
            </p>
            <div className="flex gap-3">
              <button
                onClick={handleConfirm}
                disabled={importing}
                className="flex-1 rounded-md bg-brand py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {importing ? 'Importing…' : 'Confirm'}
              </button>
              <button
                onClick={() => setPlan(null)}
                disabled={importing}
                className="flex-1 rounded-md bg-slate-700 py-2 text-sm text-slate-200 disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
            {importError && <p className="mt-2 text-xs text-red-400">{importError}</p>}
          </div>
        </div>
      )}
    </>
  );
}
