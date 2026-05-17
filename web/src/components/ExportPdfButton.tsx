import { useState } from 'react';
import { api } from '../lib/api';

export function ExportPdfButton({ farmId }: { farmId: string }) {
  const [busy, setBusy] = useState(false);

  const exportPdf = async () => {
    setBusy(true);
    try {
      const res = await fetch(api.exportPdfUrl(farmId), { method: 'POST' });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'farm_map.pdf';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={exportPdf}
      disabled={busy}
      className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
    >
      {busy ? 'Rendering…' : 'Export PDF'}
    </button>
  );
}
