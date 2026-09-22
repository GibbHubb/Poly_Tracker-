import { useMemo, useState } from 'react';
import type { GeoJsonFeature, GeoJsonFeatureCollection } from '../lib/api';
import { FEATURE_COLORS, PALETTE } from '../lib/mapStyle';
import { formatArea, formatLength } from '../lib/units';
import { POINT_TYPES, type DrawKind, type PointType } from './FeatureDialog';

export interface SidebarSelection {
  kind: DrawKind;
  id: string;
  geometry: GeoJsonFeature['geometry'];
  name: string;
  color: string;
  type: PointType;
  notes: string | null;
  diameter_mm: number | null;
  depth_m: number | null;
  material: string | null;
  installed_date: string | null;
  // Derived, read-only (PT6): poly-run length / paddock area in base units.
  length_m: number | null;
  area_m2: number | null;
  // PT18-fu2 — the row version this selection was read at, sent back as
  // If-Match so a stale edit is refused with 412 instead of silently
  // overwriting someone else's. Poly runs carry one since PT30; null only for
  // a row read before its version existed.
  version: number | null;
}

interface Props {
  paddocks: GeoJsonFeatureCollection;
  polyRuns: GeoJsonFeatureCollection;
  features: GeoJsonFeatureCollection;
  onSelect: (sel: SidebarSelection) => void;
}

const DEFAULT_COLOR: Record<DrawKind, string> = {
  paddock: '#22d3ee',
  polyRun: '#f97316',
  feature: '#38bdf8',
};

function selectionOf(
  kind: DrawKind,
  f: GeoJsonFeature,
): SidebarSelection {
  const p = f.properties;
  const type = (p.type as PointType) ?? 'other';
  const numOrNull = (v: unknown): number | null => {
    const n = Number(v);
    return v != null && v !== '' && Number.isFinite(n) ? n : null;
  };
  const strOrNull = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() !== '' ? v : null;
  return {
    kind,
    id: String(f.id),
    geometry: f.geometry,
    version: typeof p.version === 'number' ? p.version : null,
    name: String(p.name ?? ''),
    color:
      typeof p.color === 'string' && p.color
        ? p.color
        : kind === 'feature'
          ? (FEATURE_COLORS[type] ?? PALETTE[0]!.value)
          : DEFAULT_COLOR[kind],
    type,
    notes: strOrNull(p.notes),
    diameter_mm: numOrNull(p.diameter_mm),
    depth_m: numOrNull(p.depth_m),
    material: strOrNull(p.material),
    // date input wants yyyy-mm-dd; trim any time component
    installed_date: strOrNull(p.installed_date)?.slice(0, 10) ?? null,
    length_m: numOrNull(p.length_m),
    area_m2: numOrNull(p.area_m2),
  };
}

/** Text a row displays — also what the search box matches against. */
function displayLabel(kind: DrawKind, f: GeoJsonFeature): string {
  const p = f.properties;
  const name = String(p.name ?? '');
  if (kind === 'feature') return name || String(p.type ?? 'other');
  return name || 'Unnamed';
}

export function FeatureSidebar({
  paddocks,
  polyRuns,
  features,
  onSelect,
}: Props) {
  const [search, setSearch] = useState('');
  const [activeTypes, setActiveTypes] = useState<Set<PointType>>(new Set());

  const q = search.trim().toLowerCase();

  const visiblePaddocks = useMemo(
    () =>
      paddocks.features.filter(
        (f) => q === '' || displayLabel('paddock', f).toLowerCase().includes(q),
      ),
    [paddocks, q],
  );
  const visiblePolyRuns = useMemo(
    () =>
      polyRuns.features.filter(
        (f) => q === '' || displayLabel('polyRun', f).toLowerCase().includes(q),
      ),
    [polyRuns, q],
  );
  const visiblePoints = useMemo(
    () =>
      features.features.filter((f) => {
        const textOk =
          q === '' || displayLabel('feature', f).toLowerCase().includes(q);
        const typeOk =
          activeTypes.size === 0 ||
          activeTypes.has((f.properties.type as PointType) ?? 'other');
        return textOk && typeOk;
      }),
    [features, q, activeTypes],
  );

  const toggleType = (t: PointType) =>
    setActiveTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });

  const allEmpty =
    visiblePaddocks.length === 0 &&
    visiblePolyRuns.length === 0 &&
    visiblePoints.length === 0;

  return (
    <aside className="w-72 shrink-0 overflow-y-auto border-l border-slate-800 bg-slate-900 p-4 text-sm">
      <SearchBar value={search} onChange={setSearch} />
      <TypeChips active={activeTypes} onToggle={toggleType} />

      {allEmpty ? (
        <p className="mt-4 text-slate-500">No features match your filters.</p>
      ) : (
        <>
          <Section title={`Paddocks (${visiblePaddocks.length})`}>
            {visiblePaddocks.map((f) => {
              const s = selectionOf('paddock', f);
              return (
                <Row
                  key={f.id}
                  label={s.name || 'Unnamed'}
                  color={s.color}
                  meta={formatArea(s.area_m2) || undefined}
                  onClick={() => onSelect(s)}
                />
              );
            })}
          </Section>

          <Section title={`Poly runs (${visiblePolyRuns.length})`}>
            {visiblePolyRuns.map((f) => {
              const s = selectionOf('polyRun', f);
              const meta = [
                formatLength(s.length_m),
                s.diameter_mm ? `${String(s.diameter_mm)} mm` : '',
              ]
                .filter(Boolean)
                .join(' · ');
              return (
                <Row
                  key={f.id}
                  label={s.name || 'Unnamed'}
                  color={s.color}
                  meta={meta || undefined}
                  onClick={() => onSelect(s)}
                />
              );
            })}
          </Section>

          <Section title={`Points (${visiblePoints.length})`}>
            {visiblePoints.map((f) => {
              const s = selectionOf('feature', f);
              return (
                <Row
                  key={f.id}
                  label={s.name || s.type}
                  color={s.color}
                  meta={s.type}
                  onClick={() => onSelect(s)}
                />
              );
            })}
          </Section>
        </>
      )}
    </aside>
  );
}

function SearchBar({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="relative mb-3">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search by name…"
        className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 pr-7 text-sm outline-none focus:border-brand"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          title="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
        >
          ✕
        </button>
      )}
    </div>
  );
}

function TypeChips({
  active,
  onToggle,
}: {
  active: Set<PointType>;
  onToggle: (t: PointType) => void;
}) {
  return (
    <div className="mb-3 flex flex-wrap gap-1">
      {POINT_TYPES.map((t) => {
        const on = active.has(t);
        return (
          <button
            key={t}
            type="button"
            onClick={() => onToggle(t)}
            className={`rounded-full px-2 py-0.5 text-xs ${
              on ? 'bg-brand text-white' : 'bg-slate-800 text-slate-300'
            }`}
          >
            {t.replace('_', ' ')}
          </button>
        );
      })}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-5">
      <h3 className="mb-2 font-semibold text-slate-300">{title}</h3>
      <ul className="space-y-1">{children}</ul>
    </section>
  );
}

function Row({
  label,
  meta,
  color,
  onClick,
}: {
  label: string;
  meta?: string;
  color?: string;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        onClick={onClick}
        className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-slate-800"
      >
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: color ?? '#64748b' }}
        />
        <span className="flex-1 truncate">{label}</span>
        {meta && <span className="text-xs text-slate-500">{meta}</span>}
      </button>
    </li>
  );
}
