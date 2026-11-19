import { useEffect, useState } from 'react';

/**
 * PT34 — the one layout breakpoint: below Tailwind's `md` (768 px) is a phone. 767.98, not 767:
 * Tailwind's `max-md:` is `not all and (min-width: 768px)`, so a fractional width such as 767.5
 * (zoom, a DPR-scaled window) is `max-md` there and must be a phone here too.
 */
export const PHONE_QUERY = '(max-width: 767.98px)';

function matches(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(PHONE_QUERY).matches
    : false;
}

/** True while the viewport is below the `md` breakpoint; follows resizes and rotation. */
export function useIsPhone(): boolean {
  const [phone, setPhone] = useState(matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(PHONE_QUERY);
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
}
