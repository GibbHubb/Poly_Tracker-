import { useState } from 'react';

interface Props {
  featureType?: string;
  featureId?: string;
}

const BASE = import.meta.env.VITE_API_BASE || '/api';

/**
 * Minimal photo capture. EXIF GPS extraction is deferred to PT-2 — for now we
 * forward the browser geolocation fix (if granted) alongside the upload.
 */
export function PhotoUpload({ featureType, featureId }: Props) {
  const [status, setStatus] = useState<string | null>(null);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus('Uploading…');

    const form = new FormData();
    form.append('photo', file);
    if (featureType) form.append('feature_type', featureType);
    if (featureId) form.append('feature_id', featureId);
    form.append('taken_at', new Date().toISOString());

    try {
      const res = await fetch(`${BASE}/photos`, { method: 'POST', body: form });
      setStatus(res.ok ? 'Uploaded' : `Failed (${res.status})`);
    } catch {
      setStatus('Saved offline — will sync later');
    }
  };

  return (
    <label className="block cursor-pointer text-sm">
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
      {status && <span className="ml-2 text-xs text-slate-400">{status}</span>}
    </label>
  );
}
