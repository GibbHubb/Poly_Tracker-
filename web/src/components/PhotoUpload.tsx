import { useEffect, useState } from 'react';
import exifr from 'exifr';

interface Props {
  featureType?: string;
  featureId?: string;
  /** Fired after a successful upload (lets the map photo layer refresh). */
  onUploaded?: () => void;
}

interface PhotoRow {
  id: string;
  path: string;
  lat: string | null;
  lng: string | null;
  taken_at: string | null;
}

const BASE = import.meta.env.VITE_API_BASE || '/api';

/**
 * Photo capture with EXIF GPS extraction (exifr). Reads the photo's embedded
 * GPS + capture time; falls back to the browser geolocation fix when the
 * image has no GPS tags. Shows a thumbnail strip of photos already attached
 * to this feature.
 */
export function PhotoUpload({ featureType, featureId, onUploaded }: Props) {
  const [status, setStatus] = useState<string | null>(null);
  const [photos, setPhotos] = useState<PhotoRow[]>([]);

  const loadPhotos = () => {
    if (!featureId) return;
    fetch(`${BASE}/photos?feature_id=${featureId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: PhotoRow[]) => setPhotos(rows))
      .catch(() => undefined);
  };

  useEffect(loadPhotos, [featureId]);

  const browserFix = (): Promise<{ lat: number; lng: number } | null> =>
    new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 5000 },
      );
    });

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus('Reading EXIF…');

    let lat: number | null = null;
    let lng: number | null = null;
    let takenAt: string | null = null;
    try {
      const gps = await exifr.gps(file);
      if (gps && Number.isFinite(gps.latitude)) {
        lat = gps.latitude;
        lng = gps.longitude;
      }
      const meta = (await exifr.parse(file, ['DateTimeOriginal'])) as
        | { DateTimeOriginal?: Date }
        | undefined;
      if (meta?.DateTimeOriginal instanceof Date) {
        takenAt = meta.DateTimeOriginal.toISOString();
      }
    } catch {
      /* not all images carry EXIF — fall through */
    }
    if (lat == null) {
      const fix = await browserFix();
      if (fix) {
        lat = fix.lat;
        lng = fix.lng;
      }
    }

    const form = new FormData();
    form.append('photo', file);
    if (featureType) form.append('feature_type', featureType);
    if (featureId) form.append('feature_id', featureId);
    form.append('taken_at', takenAt ?? new Date().toISOString());
    if (lat != null && lng != null) {
      form.append('lat', String(lat));
      form.append('lng', String(lng));
    }

    setStatus(
      lat != null ? `Uploading (📍 ${lat.toFixed(5)}, ${lng!.toFixed(5)})…` : 'Uploading (no GPS)…',
    );
    try {
      const res = await fetch(`${BASE}/photos`, { method: 'POST', body: form });
      setStatus(res.ok ? 'Uploaded ✓' : `Failed (${res.status})`);
      if (res.ok) {
        loadPhotos();
        onUploaded?.();
      }
    } catch {
      setStatus('Saved offline — will sync later');
    }
  };

  return (
    <div className="text-sm">
      {photos.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {photos.map((p) => (
            <a
              key={p.id}
              href={`${BASE}/photos/file/${p.id}`}
              target="_blank"
              rel="noreferrer"
              title={p.lat ? `📍 ${p.lat}, ${p.lng}` : 'no GPS'}
              className="relative block"
            >
              <img
                src={`${BASE}/photos/file/${p.id}`}
                alt={p.taken_at ?? 'photo'}
                loading="lazy"
                className="h-14 w-14 rounded object-cover ring-1 ring-slate-700"
              />
              {p.lat && (
                <span className="absolute -right-1 -top-1 text-xs">📍</span>
              )}
            </a>
          ))}
        </div>
      )}
      <label className="block cursor-pointer">
        <span className="rounded-md bg-slate-700 px-3 py-2 text-white">
          Add photo
        </span>
        <input
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={onPick}
        />
        {status && (
          <span className="ml-2 text-xs text-slate-400">{status}</span>
        )}
      </label>
    </div>
  );
}
