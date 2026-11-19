import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { GeoJsonFeature, GeoJsonFeatureCollection } from '../lib/api';
import { FEATURE_COLORS, PALETTE } from '../lib/mapStyle';
import { formatArea, formatLength } from '../lib/units';
import { POINT_TYPES, type DrawKind, type PointType } from './FeatureDialog';
import { isPendingFeature } from '../lib/pendingOverlay';
import { ROW_PITCH, ROW_PITCH_TOUCH, WINDOW_FROM, windowRange } from '../lib/windowRange';
import { useIsPhone } from '../hooks/useIsPhone';

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
  /**
   * PT34 — below `md` the list is a bottom sheet over the map, shown only while
   * `open`; at `md` and up it is the same side-by-side aside as before and these
   * two props change nothing. `onClose` runs on the sheet's Close button and on
   * Escape inside it; the caller returns focus to whatever opened it.
   */
  open?: boolean;
  onClose?: () => void;
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
  open = false,
  onClose,
}: Props) {
  const phone = useIsPhone();
  const pitch = phone ? ROW_PITCH_TOUCH : ROW_PITCH;
  const [search, setSearch] = useState('');
  const [activeTypes, setActiveTypes] = useState<Set<PointType>>(new Set());
  // PT32 — the scroll container the windowed lists measure against. State, not
  // a ref, so the lists re-render once it exists.
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);

  // PT34 review — on a phone, opening the sheet moves focus into it, so a keyboard or
  // screen-reader user lands in the list they asked for (and Escape reaches it).
  useEffect(() => {
    if (phone && open) scrollEl?.focus({ preventScroll: true });
  }, [phone, open, scrollEl]);

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
    <aside
      id="feature-list"
      ref={setScrollEl}
      data-testid="feature-list"
      // PT34 review — on a phone the sheet is a NON-modal dialog: the map behind it stays
      // usable (pan to a paddock, then pick it in the list), so there is no focus trap and no
      // aria-modal="true", which would tell a screen reader the map is inert when it is not.
      // At `md` and up it stays a plain aside (a complementary landmark) named "Features".
      role={phone ? 'dialog' : undefined}
      aria-modal={phone ? false : undefined}
      aria-label="Features"
      tabIndex={phone ? -1 : undefined}
      onKeyDown={(e) => {
        // Scoped to the sheet, not the document: Escape on the map belongs to the draw tool.
        if (phone && open && e.key === 'Escape') {
          e.stopPropagation();
          onClose?.();
        }
      }}
      className={`w-72 outline-none shrink-0 overflow-y-auto border-l border-slate-800 bg-slate-900 p-4 text-sm max-md:absolute max-md:inset-x-0 max-md:bottom-0 max-md:z-20 max-md:h-[55%] max-md:w-full max-md:touch-pan-y max-md:overscroll-contain max-md:rounded-t-2xl max-md:border-l-0 max-md:border-t max-md:pt-0 max-md:shadow-2xl ${open ? '' : 'max-md:hidden'}`}
    >
      <div className="sticky top-0 z-10 -mx-4 mb-2 flex items-center justify-between bg-slate-900 px-4 pt-2 md:hidden">
        <span aria-hidden className="absolute left-1/2 top-1.5 h-1 w-10 -translate-x-1/2 rounded-full bg-slate-600" />
        <h2 className="font-semibold text-slate-200">Features</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close feature list"
          className="flex h-11 min-w-[44px] items-center justify-center rounded-md px-3 text-slate-300 hover:bg-slate-800"
        >
          Close
        </button>
      </div>
      <SearchBar value={search} onChange={setSearch} />
      <TypeChips active={activeTypes} onToggle={toggleType} />

      {allEmpty ? (
        <p className="mt-4 text-slate-500">No features match your filters.</p>
      ) : (
        <>
          <Section title={`Paddocks (${visiblePaddocks.length})`}>
            <WindowedRows items={visiblePaddocks} scrollEl={scrollEl} pitch={pitch} render={(f, style) => {
              const s = selectionOf('paddock', f);
              return (
                <Row
                  key={f.id}
                  style={style}
                  label={s.name || 'Unnamed'}
                  color={s.color}
                  meta={formatArea(s.area_m2) || undefined}
                  pending={isPendingFeature(f)}
                  onClick={() => onSelect(s)}
                />
              );
            }} />
          </Section>

          <Section title={`Poly runs (${visiblePolyRuns.length})`}>
            <WindowedRows items={visiblePolyRuns} scrollEl={scrollEl} pitch={pitch} render={(f, style) => {
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
                  style={style}
                  label={s.name || 'Unnamed'}
                  color={s.color}
                  meta={meta || undefined}
                  pending={isPendingFeature(f)}
                  onClick={() => onSelect(s)}
                />
              );
            }} />
          </Section>

          <Section title={`Points (${visiblePoints.length})`}>
            <WindowedRows items={visiblePoints} scrollEl={scrollEl} pitch={pitch} render={(f, style) => {
              const s = selectionOf('feature', f);
              return (
                <Row
                  key={f.id}
                  style={style}
                  label={s.name || s.type}
                  color={s.color}
                  meta={s.type}
                  pending={isPendingFeature(f)}
                  onClick={() => onSelect(s)}
                />
              );
            }} />
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
        className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 pr-7 text-sm outline-none focus:border-brand max-md:min-h-[44px] max-md:pr-11 max-md:text-base"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          title="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 max-md:right-0 max-md:flex max-md:h-11 max-md:w-11 max-md:items-center max-md:justify-center"
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
            className={`rounded-full px-2 py-0.5 text-xs max-md:min-h-[44px] max-md:px-3 max-md:text-sm ${
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
  children: ReactNode;
}) {
  return (
    <section className="mb-5">
      <h3 className="mb-2 font-semibold text-slate-300">{title}</h3>
      {children}
    </section>
  );
}

/**
 * PT32 — renders only the rows that intersect the sidebar's scroll viewport
 * (plus an overscan), absolutely positioned inside a spacer of the full list
 * height, so a farm with 5,000 points mounts a few dozen buttons instead of
 * 5,000. The three lists share one scroll container, so each measures its own
 * offset within it rather than owning a scroller. Short lists are unchanged.
 * Known trade-off: Tab reaches only mounted rows; past the window, scroll or
 * use the search box (which is what a 5,000-row list needs anyway).
 */
function WindowedRows({
  items,
  scrollEl,
  pitch,
  render,
}: {
  items: GeoJsonFeature[];
  scrollEl: HTMLElement | null;
  /** PT34 — row pitch in use: ROW_PITCH, or ROW_PITCH_TOUCH on a phone. */
  pitch: number;
  render: (f: GeoJsonFeature, style?: CSSProperties) => ReactNode;
}) {
  const listRef = useRef<HTMLUListElement | null>(null);
  const [range, setRange] = useState<[number, number]>([0, 40]);
  const windowed = items.length >= WINDOW_FROM;
  const count = items.length;

  // Re-measure on scroll and on resize of the scroller…
  const measure = useRef<() => void>(() => {});
  measure.current = () => {
    const list = listRef.current;
    if (!windowed || !scrollEl || !list) return;
    // Distance from the top of the visible scroll area to the list's top.
    const top = list.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top;
    const next = windowRange(top, scrollEl.clientHeight, count, pitch);
    setRange((prev) => (prev[0] === next[0] && prev[1] === next[1] ? prev : next));
  };
  useLayoutEffect(() => {
    if (!windowed || !scrollEl) return;
    const update = () => measure.current();
    scrollEl.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    ro?.observe(scrollEl);
    return () => {
      scrollEl.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, [windowed, scrollEl]);
  // …and after every render: a section above this one can grow or shrink
  // (an import, a sync) and move this list with no scroll event at all. The
  // equality guard in setRange makes the no-change case free.
  useLayoutEffect(() => measure.current());

  if (!windowed) return <ul className="space-y-1">{items.map((f) => render(f))}</ul>;

  const [a, b] = range;
  return (
    <ul ref={listRef} className="relative" style={{ height: count * pitch }}>
      {items.slice(a, b).map((f, k) =>
        render(f, { position: 'absolute', left: 0, right: 0, top: (a + k) * pitch, height: pitch }),
      )}
    </ul>
  );
}

function Row({
  label,
  meta,
  color,
  pending,
  style,
  onClick,
}: {
  /** PT32 — position inside a windowed list; absent in a plain one. */
  style?: CSSProperties;
  label: string;
  meta?: string;
  color?: string;
  /** PT29 — queued offline, not on the server yet: shown, but not editable until it syncs. */
  pending?: boolean;
  onClick: () => void;
}) {
  return (
    <li style={style}>
      <button
        onClick={onClick}
        disabled={pending}
        data-pending={pending ? 'true' : undefined}
        title={pending ? 'Saved on this device; waiting to sync. Editable once it has synced.' : undefined}
        className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-slate-800 max-md:min-h-[44px] disabled:cursor-default disabled:opacity-70 disabled:hover:bg-transparent"
      >
        {pending && <span aria-label="waiting to sync">⏳</span>}
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
