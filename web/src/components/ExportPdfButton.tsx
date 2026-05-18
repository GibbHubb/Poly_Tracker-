import { useState } from 'react';

interface Props {
  onExport: () => Promise<void>;
}

export function ExportPdfButton({ onExport }: Props) {
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      await onExport();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={run}
      disabled={busy}
      className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
    >
      {busy ? 'Exporting…' : 'Export PDF'}
    </button>
  );
}
