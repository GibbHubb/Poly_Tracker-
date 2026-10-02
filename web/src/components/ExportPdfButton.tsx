import { useState } from 'react';
import { notify } from '../lib/notify';

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
      // PT35 — a notice, not an alert(); export is local, so the message is ours to show.
      console.warn('[Export PDF]', e);
      notify('error', `Export PDF failed: ${e instanceof Error ? e.message : 'unknown error'}.`);
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
