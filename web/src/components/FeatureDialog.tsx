import { useEffect, useState } from 'react';
import { PALETTE } from '../lib/mapStyle';

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
}

interface Props {
  kind: DrawKind | null;
  mode?: 'create' | 'edit';
  initial?: FeatureDialogResult;
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

export function FeatureDialog({
  kind,
  mode = 'create',
  initial,
  onCancel,
  onSubmit,
  onDelete,
}: Props) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(PALETTE[0]!.value);
  const [type, setType] = useState<PointType>('trough');

  // (Re)seed fields each time the dialog opens — blank for create, the
  // feature's current values for edit.
  useEffect(() => {
    if (!kind) return;
    setName(initial?.name ?? '');
    setColor(initial?.color ?? PALETTE[0]!.value);
    setType(initial?.type ?? 'trough');
  }, [kind, initial?.name, initial?.color, initial?.type]);

  if (!kind) return null;

  const titles = mode === 'edit' ? EDIT_TITLES : CREATE_TITLES;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSubmit({ name: name.trim(), color, type });
  };

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/50 p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-lg border border-slate-700 bg-slate-900 p-5 text-slate-100 shadow-2xl"
      >
        <h2 className="mb-4 text-lg font-semibold">{titles[kind]}</h2>

        <label className="mb-1 block text-sm text-slate-300">Name</label>
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
          className="mb-4 w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm outline-none focus:border-brand"
        />

        {kind === 'feature' && (
          <>
            <label className="mb-1 block text-sm text-slate-300">Type</label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as PointType)}
              className="mb-4 w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm"
            >
              {POINT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.replace('_', ' ')}
                </option>
              ))}
            </select>
          </>
        )}

        <label className="mb-1 block text-sm text-slate-300">Colour</label>
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
