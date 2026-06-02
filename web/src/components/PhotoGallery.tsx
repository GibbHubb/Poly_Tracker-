import { useCallback, useEffect, useState } from 'react';
import { api, type Photo } from '../lib/api';

interface Props {
  farmId: string;
  onClose: () => void;
  /** Called after a successful delete so the map photo layer can refresh. */
  onChanged?: () => void;
}

function formatTaken(taken_at: string | null): string {
  if (!taken_at) return 'Unknown';
  const d = new Date(taken_at);
  return Number.isNaN(d.getTime()) ? 'Unknown' : d.toLocaleString();
}

function formatCoords(lat: string | null, lng: string | null): string {
  const a = Number(lat);
  const b = Number(lng);
  if (lat == null || lng == null || !Number.isFinite(a) || !Number.isFinite(b)) {
    return 'No GPS';
  }
  return `${a.toFixed(5)}, ${b.toFixed(5)}`;
}

/**
 * Per-farm photo gallery overlay (PT10). Thumbnail grid → lightbox with
 * capture time + coordinates and a delete action. Stays mounted over the map
 * (not a route) so closing returns instantly with map state intact.
 */
export function PhotoGallery({ farmId, onClose, onChanged }: Props) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Photo | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .listPhotos({ farmId })
      .then((rows) => {
        if (alive) setPhotos(rows);
      })
      .catch(() => {
        if (alive) setError('Could not load photos.');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [farmId]);

  // Esc closes the lightbox first, then the gallery.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (selected) setSelected(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, onClose]);

  const handleDelete = useCallback(
    async (photo: Photo) => {
      if (!confirm('Delete this photo? This cannot be undone.')) return;
      setDeletingId(photo.id);
      try {
        await api.deletePhoto(photo.id);
        setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
        setSelected((cur) => (cur?.id === photo.id ? null : cur));
        onChanged?.();
      } catch {
        setError('Delete failed — check your connection and try again.');
      } finally {
        setDeletingId(null);
      }
    },
    [onChanged],
  );

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-slate-950/95">
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
        <h2 className="text-base font-semibold text-slate-100">
          Photos ({photos.length})
        </h2>
        <button
          onClick={onClose}
          title="Close gallery"
          className="rounded-md bg-slate-800 px-3 py-1 text-sm text-slate-200"
        >
          ✕ Close
        </button>
      </div>

      {error && (
        <p className="bg-red-900/40 px-4 py-2 text-sm text-red-200">{error}</p>
      )}

      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <p className="text-slate-400">Loading…</p>
        ) : photos.length === 0 ? (
          <p className="text-slate-400">
            No photos yet. Upload one from a point feature's edit dialog.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {photos.map((p) => (
              <button
                key={p.id}
                onClick={() => setSelected(p)}
                className="group relative aspect-square overflow-hidden rounded-md bg-slate-800"
                title={formatTaken(p.taken_at)}
              >
                <img
                  src={api.photoFileUrl(p.id)}
                  alt=""
                  loading="lazy"
                  className="h-full w-full object-cover transition group-hover:opacity-80"
                />
                {(p.lat == null || p.lng == null) && (
                  <span className="absolute bottom-1 right-1 rounded bg-slate-900/80 px-1 text-[10px] text-slate-300">
                    no GPS
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {selected && (
        <div
          className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/85 p-4"
          onClick={() => setSelected(null)}
        >
          <img
            src={api.photoFileUrl(selected.id)}
            alt=""
            onClick={(e) => e.stopPropagation()}
            className="max-h-[75vh] max-w-full rounded-md object-contain"
          />
          <div
            onClick={(e) => e.stopPropagation()}
            className="mt-3 flex flex-col items-center gap-2 text-sm text-slate-200"
          >
            <div className="flex gap-4">
              <span>📅 {formatTaken(selected.taken_at)}</span>
              <span>📍 {formatCoords(selected.lat, selected.lng)}</span>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setSelected(null)}
                className="rounded-md bg-slate-700 px-4 py-1.5"
              >
                Back
              </button>
              <button
                onClick={() => handleDelete(selected)}
                disabled={deletingId === selected.id}
                className="rounded-md bg-red-600 px-4 py-1.5 font-medium text-white disabled:opacity-50"
              >
                {deletingId === selected.id ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
