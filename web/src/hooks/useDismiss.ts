import { useEffect, useRef, type RefObject } from 'react';

export type DismissReason = 'escape' | 'outside';

/**
 * PT34 review — close a popover (the phone ⋯ menu) on Escape anywhere, or on a press
 * that starts outside `ref` (mouse, pen or touch: `pointerdown`, in the capture phase so
 * a handler that stops propagation, such as the map's, cannot swallow it). Listens only
 * while `open`. The press is not cancelled: tapping the map closes the menu AND reaches
 * the map, because the menu is not modal.
 */
export function useDismiss(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  onDismiss: (reason: DismissReason) => void,
): void {
  const cb = useRef(onDismiss);
  cb.current = onDismiss;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cb.current('escape');
    };
    const onDown = (e: Event) => {
      const el = ref.current;
      if (el && e.target instanceof Node && !el.contains(e.target)) cb.current('outside');
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [open, ref]);
}
