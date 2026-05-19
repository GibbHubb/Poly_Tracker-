import type { GeoJsonFeature, GeoJsonFeatureCollection } from '../lib/api';
import { FEATURE_COLORS, PALETTE } from '../lib/mapStyle';
import type { DrawKind, PointType } from './FeatureDialog';

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
  };
}

export function FeatureSidebar({
  paddocks,
  polyRuns,
  features,
  onSelect,
}: Props) {
  return (
    <aside className="w-72 shrink-0 overflow-y-auto border-l border-slate-800 bg-slate-900 p-4 text-sm">
      <Section title={`Paddocks (${paddocks.features.length})`}>
        {paddocks.features.map((f) => {
          const s = selectionOf('paddock', f);
          return (
            <Row
              key={f.id}
              label={s.name || 'Unnamed'}
              color={s.color}
              onClick={() => onSelect(s)}
            />
          );
        })}
      </Section>

      <Section title={`Poly runs (${polyRuns.features.length})`}>
        {polyRuns.features.map((f) => {
          const s = selectionOf('polyRun', f);
          return (
            <Row
              key={f.id}
              label={s.name || 'Unnamed'}
              color={s.color}
              meta={
                f.properties.diameter_mm
                  ? `${String(f.properties.diameter_mm)} mm`
                  : undefined
              }
              onClick={() => onSelect(s)}
            />
          );
        })}
      </Section>

      <Section title={`Points (${features.features.length})`}>
        {features.features.map((f) => {
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
    </aside>
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
