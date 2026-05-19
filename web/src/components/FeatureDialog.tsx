import { useEffect, useState } from 'react';
import { PALETTE } from '../lib/mapStyle';
import { PhotoUpload } from './PhotoUpload';

export type DrawKind = 'paddock' | 'polyRun' | 'feature';

export type PointType =
  | 'trough'
  | 'turkey_nest'
  | 'bore'
  | 'gate'
  | 'tank'
  | 'other';

export interface FeatureDialogResult {
  name: string;
  color: string;
  type: PointType;
  notes: string | null;
  // poly-run only
  diameter_mm: number | null;
  depth_m: number | null;
  material: string | null;
  installed_date: string | null; // ISO yyyy-mm-dd
}

interface Props {
  kind: DrawKind | null;
  mode?: 'create' | 'edit';
  initial?: FeatureDialogResult;
  /** Existing feature id — enables photo upload in edit mode. */
  featureId?: string;
  /** Called after a photo uploads, so the map photo layer can refresh. */
  onPhotoUploaded?: () => void;
  onCancel: () => void;
  onSubmit: (r: FeatureDialogResult) => void;
  onDelete?: () => void;
}

const CREATE_TITLES: Record<DrawKind, string> = {
  paddock: 'New paddock',
  polyRun: 'New poly run',
  feature: 'New point',
};

const EDIT_TITLES: Record<DrawKind, string> = {
  paddock: 'Edit paddock',
  polyRun: 'Edit poly run',
  feature: 'Edit point',
};

const POINT_TYPES: PointType[] = [
  'trough',
  'turkey_nest',
  'bore',
  'gate',
  'tank',
  'other',
];

const inputCls =
  'mb-4 w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm outline-none focus:border-brand';
const labelCls = 'mb-1 block text-sm text-slate-300';

export function FeatureDialog({
  kind,
  mode = 'create',
  initial,
  featureId,
  onPhotoUploaded,
  onCancel,
  onSubmit,
  onDelete,
}: Props) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(PALETTE[0]!.value);
  const [type, setType] = useState<PointType>('trough');
  const [notes, setNotes] = useState('');
  const [diameter, setDiameter] = useState('');
  const [depth, setDepth] = useState('');
  const [material, setMaterial] = useState('');
  const [installed, setInstalled] = useState('');

  // (Re)seed fields each time the dialog opens — blank for create, the
  // feature's current values for edit.
  useEffect(() => {
    if (!kind) return;
    setName(initial?.name ?? '');
    setColor(initial?.color ?? PALETTE[0]!.value);
    setType(initial?.type ?? 'trough');
    setNotes(initial?.notes ?? '');
    setDiameter(
      initial?.diameter_mm != null ? String(initial.diameter_mm) : '',
    );
    setDepth(initial?.depth_m != null ? String(initial.depth_m) : '');
    setMaterial(initial?.material ?? '');
    setInstalled(initial?.installed_date ?? '');
  }, [
    kind,
    initial?.name,
    initial?.color,
    initial?.type,
    initial?.notes,
    initial?.diameter_mm,
    initial?.depth_m,
    initial?.material,
    initial?.installed_date,
  ]);

  if (!kind) return null;

  const titles = mode === 'edit' ? EDIT_TITLES : CREATE_TITLES;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const num = (s: string): number | null => {
      const n = Number(s);
      return s.trim() !== '' && Number.isFinite(n) ? n : null;
    };
    onSubmit({
      name: name.trim(),
      color,
      type,
      notes: notes.trim() || null,
      diameter_mm: kind === 'polyRun' ? num(diameter) : null,
      depth_m: kind === 'polyRun' ? num(depth) : null,
      material: kind === 'polyRun' ? material.trim() || null : null,
      installed_date: kind === 'polyRun' ? installed || null : null,
    });
  };

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/50 p-4">
      <form
        onSubmit={submit}
        className="max-h-full w-full max-w-sm overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 p-5 text-slate-100 shadow-2xl"
      >
        <h2 className="mb-4 text-lg font-semibold">{titles[kind]}</h2>

        <label className={labelCls}>Name</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={
            kind === 'polyRun'
              ? 'e.g. North bore line'
              : kind === 'paddock'
                ? 'e.g. River paddock'
                : 'e.g. Trough 3'
          }
          className={inputCls}
        />

        {kind === 'feature' && (
          <>
            <label className={labelCls}>Type</label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as PointType)}
              className={inputCls}
            >
              {POINT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.replace('_', ' ')}
                </option>
              ))}
            </select>
          </>
        )}

        {kind === 'polyRun' && (
          <>
            <label className={labelCls}>Diameter (mm)</label>
            <input
              type="number"
              min="0"
              value={diameter}
              onChange={(e) => setDiameter(e.target.value)}
              placeholder="e.g. 50"
              className={inputCls}
            />
            <label className={labelCls}>Depth (m)</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={depth}
              onChange={(e) => setDepth(e.target.value)}
              placeholder="e.g. 0.6"
              className={inputCls}
            />
            <label className={labelCls}>Material</label>
            <input
              value={material}
              onChange={(e) => setMaterial(e.target.value)}
              placeholder="e.g. poly / PVC"
              className={inputCls}
            />
            <label className={labelCls}>Installed date</label>
            <input
              type="date"
              value={installed}
              onChange={(e) => setInstalled(e.target.value)}
              className={inputCls}
            />
          </>
        )}

        <label className={labelCls}>Notes</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          placeholder="optional"
          className={inputCls}
        />

        {mode === 'edit' && kind === 'feature' && featureId && (
          <div className="mb-4">
            <label className={labelCls}>Photos</label>
            <PhotoUpload
              featureType={type}
              featureId={featureId}
              onUploaded={onPhotoUploaded}
            />
          </div>
        )}

        <label className={labelCls}>Colour</label>
        <div className="mb-5 flex flex-wrap gap-2">
          {PALETTE.map((c) => (
            <button
              key={c.value}
              type="button"
              title={c.name}
              onClick={() => setColor(c.value)}
              className={`h-8 w-8 rounded-full border-2 ${
                color === c.value ? 'border-white' : 'border-transparent'
              }`}
              style={{ backgroundColor: c.value }}
            />
          ))}
        </div>

        <div className="flex items-center gap-2">
          {mode === 'edit' && onDelete && (
            <button
              type="button"
              onClick={() => {
                if (confirm('Delete this feature? This cannot be undone.')) {
                  onDelete();
                }
              }}
              className="mr-auto rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white"
            >
              Delete
            </button>
          )}
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md bg-slate-700 px-4 py-2 text-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim()}
            className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
