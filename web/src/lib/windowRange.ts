// PT32 — the arithmetic behind the sidebar's windowed lists, kept pure so it
// is tested without a DOM (components/FeatureSidebar.tsx renders with it).

/** Row pitch: a 28 px button (py-1 + 20 px line) plus the 4 px `space-y-1` gap. */
export const ROW_PITCH = 32;
/** PT34 — on a phone each row is a 44 px touch target, plus the same 4 px gap. */
export const ROW_PITCH_TOUCH = 48;
/** Below this a list renders every row, exactly as before PT32. */
export const WINDOW_FROM = 60;
export const OVERSCAN = 10;

/**
 * PT32 — which rows of a windowed list to mount: those within the scroll
 * viewport plus OVERSCAN either side. `listTop` is the list's top relative to
 * the top of the visible scroll area (negative once scrolled past). `pitch` is
 * the row pitch in use (PT34: taller on phones).
 */
export function windowRange(
  listTop: number,
  viewportHeight: number,
  count: number,
  pitch: number = ROW_PITCH,
): [number, number] {
  const first = Math.min(count, Math.max(0, Math.floor(-listTop / pitch) - OVERSCAN));
  const last = Math.min(count, Math.ceil((viewportHeight - listTop) / pitch) + OVERSCAN);
  return [first, Math.max(first, last)];
}
