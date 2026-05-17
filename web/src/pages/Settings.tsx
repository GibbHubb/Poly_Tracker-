import { useEffect, useState } from 'react';
import { db, pendingCount } from '../lib/db';
import { replayQueue } from '../lib/sync';

export function Settings() {
  const [pending, setPending] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = () => void pendingCount().then(setPending);
  useEffect(refresh, []);

  const tokenSet = Boolean(import.meta.env.VITE_MAPBOX_TOKEN);

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4">
      <h1 className="text-xl font-semibold">Settings</h1>

      <section className="rounded-lg border border-slate-800 p-4">
        <h2 className="mb-2 font-medium">Map tiles</h2>
        <p className="text-sm text-slate-400">
          Mapbox token:{' '}
          {tokenSet ? (
            <span className="text-emerald-400">configured</span>
          ) : (
            <span className="text-amber-400">missing — set MAPBOX_TOKEN</span>
          )}
        </p>
      </section>

      <section className="rounded-lg border border-slate-800 p-4">
        <h2 className="mb-2 font-medium">Offline queue</h2>
        <p className="mb-3 text-sm text-slate-400">
          {pending} mutation(s) waiting to sync.
        </p>
        <div className="flex gap-2">
          <button
            onClick={async () => {
              const r = await replayQueue();
              setMsg(`Replayed ${r.replayed}, ${r.conflicts.length} conflict(s)`);
              refresh();
            }}
            className="rounded-md bg-brand px-4 py-2 text-sm text-white"
          >
            Sync now
          </button>
          <button
            onClick={async () => {
              await db.pending.clear();
              setMsg('Queue cleared');
              refresh();
            }}
            className="rounded-md bg-slate-700 px-4 py-2 text-sm text-white"
          >
            Clear queue
          </button>
        </div>
        {msg && <p className="mt-3 text-sm text-slate-400">{msg}</p>}
      </section>
    </div>
  );
}
