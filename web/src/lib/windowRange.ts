// PT32 — the arithmetic behind the sidebar's windowed lists, kept pure so it
// is tested without a DOM (components/FeatureSidebar.tsx renders with it).

/** Row pitch: a 28 px button (py-1 + 20 px line) plus the 4 px `space-y-1` gap. */
export const ROW_PITCH = 32;
/** Below this a list renders every row, exactly as before PT32. */
export const WINDOW_FROM = 60;
export const OVERSCAN = 10;

/**
 * PT32 — which rows of a windowed list to mount: those within the scroll
 * viewport plus OVERSCAN either side. `listTop` is the list's top relative to
 * the top of the visible scroll area (negative once scrolled past).
 */
export function windowRange(listTop: number, viewportHeight: number, count: number): [number, number] {
  const first = Math.min(count, Math.max(0, Math.floor(-listTop / ROW_PITCH) - OVERSCAN));
  const last = Math.min(count, Math.ceil((viewportHeight - listTop) / ROW_PITCH) + OVERSCAN);
  return [first, Math.max(first, last)];
}
