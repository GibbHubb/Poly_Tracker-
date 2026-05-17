import type { GeoJsonFeatureCollection } from '../lib/api';
import { FEATURE_COLORS } from '../lib/mapStyle';

interface Props {
  paddocks: GeoJsonFeatureCollection;
  polyRuns: GeoJsonFeatureCollection;
  features: GeoJsonFeatureCollection;
}

export function FeatureSidebar({ paddocks, polyRuns, features }: Props) {
  return (
    <aside className="w-72 shrink-0 overflow-y-auto border-l border-slate-800 bg-slate-900 p-4 text-sm">
      <Section title={`Paddocks (${paddocks.features.length})`}>
        {paddocks.features.map((f) => (
          <Row key={f.id} label={String(f.properties.name ?? 'Unnamed')} />
        ))}
      </Section>

      <Section title={`Poly runs (${polyRuns.features.length})`}>
        {polyRuns.features.map((f) => (
          <Row
            key={f.id}
            label={String(f.properties.name ?? 'Unnamed')}
            meta={
              f.properties.diameter_mm
                ? `${String(f.properties.diameter_mm)} mm`
                : undefined
            }
          />
        ))}
      </Section>

      <Section title={`Points (${features.features.length})`}>
        {features.features.map((f) => {
          const type = String(f.properties.type ?? 'other');
          return (
            <Row
              key={f.id}
              label={String(f.properties.name ?? type)}
              color={FEATURE_COLORS[type]}
              meta={type}
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
}: {
  label: string;
  meta?: string;
  color?: string;
}) {
  return (
    <li className="flex items-center gap-2 rounded px-2 py-1 hover:bg-slate-800">
      <span
        className="h-2.5 w-2.5 rounded-full"
        style={{ backgroundColor: color ?? '#64748b' }}
      />
      <span className="flex-1 truncate">{label}</span>
      {meta && <span className="text-xs text-slate-500">{meta}</span>}
    </li>
  );
}
