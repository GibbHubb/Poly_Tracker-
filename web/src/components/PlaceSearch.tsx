import { useEffect, useRef, useState } from 'react';

export interface PlaceHit {
  label: string;
  center: [number, number]; // [lng, lat]
  bbox?: [number, number, number, number]; // [w, s, e, n]
}

interface NominatimResult {
  display_name: string;
  lat: string;
  lon: string;
  boundingbox: [string, string, string, string]; // [s, n, w, e]
}

interface Props {
  onSelect: (hit: PlaceHit) => void;
}

/**
 * Lightweight address/place search using the free OpenStreetMap Nominatim
 * API (no token, no Mapbox quota). Debounced, AU-biased, capped results —
 * stays well within Nominatim's usage policy for occasional farm lookups.
 */
export function PlaceSearch({ onSelect }: Props) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<PlaceHit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (q.trim().length < 3) {
      setHits([]);
      return;
    }
    timer.current = window.setTimeout(async () => {
      setLoading(true);
      try {
        const url = new URL('https://nominatim.openstreetmap.org/search');
        url.searchParams.set('format', 'json');
        url.searchParams.set('q', q.trim());
        url.searchParams.set('limit', '5');
        url.searchParams.set('countrycodes', 'au');
        url.searchParams.set('addressdetails', '0');
        const res = await fetch(url, {
          headers: { 'Accept-Language': 'en' },
        });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as NominatimResult[];
        setHits(
          data.map((r) => ({
            label: r.display_name,
            center: [Number(r.lon), Number(r.lat)],
            bbox: [
              Number(r.boundingbox[2]),
              Number(r.boundingbox[0]),
              Number(r.boundingbox[3]),
              Number(r.boundingbox[1]),
            ],
          })),
        );
        setOpen(true);
      } catch {
        setHits([]);
      } finally {
        setLoading(false);
      }
    }, 450);
    return () => window.clearTimeout(timer.current);
  }, [q]);

  return (
    <div className="w-80 max-w-[70vw]">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => hits.length > 0 && setOpen(true)}
        placeholder="Search address or place…"
        className="w-full rounded-md border border-slate-700 bg-slate-900/90 px-3 py-2 text-sm text-slate-100 shadow-lg outline-none focus:border-brand"
      />
      {open && (loading || hits.length > 0) && (
        <ul className="mt-1 max-h-72 overflow-y-auto rounded-md border border-slate-700 bg-slate-900/95 text-sm shadow-xl">
          {loading && (
            <li className="px-3 py-2 text-slate-400">Searching…</li>
          )}
          {hits.map((h) => (
            <li key={h.label}>
              <button
                onClick={() => {
                  onSelect(h);
                  setOpen(false);
                  setQ(h.label.split(',')[0] ?? h.label);
                }}
                className="block w-full truncate px-3 py-2 text-left hover:bg-slate-800"
                title={h.label}
              >
                {h.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
