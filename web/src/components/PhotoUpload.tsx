import { useEffect, useState } from 'react';
import exifr from 'exifr';
import { db } from '../lib/db';
import { PhotoQueueFullError, queuePhoto } from '../lib/photoQueue';

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

  // PT28 — photos for this feature still on the device, shown from their local bytes.
  // Polled, so a queued thumbnail turns into a server one once the queue drains.
  const [queued, setQueued] = useState<{ id: string; url: string; failed: boolean }[]>([]);
  const [queueTick, setQueueTick] = useState(0);
  useEffect(() => {
    if (!featureId) return;
    let urls: string[] = [];
    let cancelled = false;
    void db.photoQueue
      .where('featureId')
      .equals(featureId)
      .toArray()
      .then((rows) => {
        if (cancelled) return;
        const next = rows.map((r) => ({ id: r.id, url: URL.createObjectURL(r.blob), failed: r.status === 'failed' }));
        urls = next.map((q) => q.url);
        setQueued(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [featureId, queueTick]);
  useEffect(() => {
    const t = window.setInterval(() => {
      setQueueTick((n) => n + 1);
      loadPhotos();
    }, 5000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [featureId]);

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
      // PT28 — this used to say "Saved offline" and keep nothing. Now it is true.
      if (!featureId) {
        setStatus('Offline, and this feature has no id yet: photo NOT saved.');
        return;
      }
      const where = lat != null ? ` 📍 ${lat.toFixed(5)}, ${lng!.toFixed(5)}` : ' (no GPS)';
      try {
        const { queued: n } = await queuePhoto({
          blob: file,
          filename: file.name || 'photo.jpg',
          featureType,
          featureId,
          lat,
          lng,
          takenAt: takenAt ?? new Date().toISOString(),
        });
        setStatus(`Queued (${n}) — will upload when back online${where}`);
        setQueueTick((t) => t + 1);
      } catch (err) {
        setStatus(
          err instanceof PhotoQueueFullError
            ? err.message
            : 'Offline, and the photo could not be stored on this device: NOT saved.',
        );
      }
    }
  };

  return (
    <div className="text-sm">
      {queued.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2" data-testid="queued-photos">
          {queued.map((q) => (
            <span
              key={q.id}
              className="relative block"
              title={q.failed ? 'Refused by the server — see Settings' : 'Waiting to upload'}
            >
              <img
                src={q.url}
                alt={q.failed ? 'photo refused by server' : 'photo waiting to upload'}
                className={`h-14 w-14 rounded object-cover opacity-80 ring-2 ${q.failed ? 'ring-red-500' : 'ring-amber-400'}`}
              />
              <span className="absolute -right-1 -top-1 text-xs">{q.failed ? '⚠️' : '⏳'}</span>
            </span>
          ))}
        </div>
      )}
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
