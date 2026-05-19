import { useCallback, useEffect, useState } from 'react';
import { db, pendingCount, type ConflictRecord } from '../lib/db';
import { replayQueue } from '../lib/sync';

export function Settings() {
  const [pending, setPending] = useState(0);
  const [conflicts, setConflicts] = useState<ConflictRecord[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void pendingCount().then(setPending);
    void db.conflicts
      .orderBy('resolvedAt')
      .reverse()
      .toArray()
      .then(setConflicts);
  }, []);
  useEffect(refresh, [refresh]);

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
            <span className="text-amber-400">
              missing — Mapbox basemap unavailable (Esri still works)
            </span>
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
              setMsg(
                `Replayed ${r.replayed}, ${r.conflicts.length} conflict(s)`,
              );
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

      <section className="rounded-lg border border-slate-800 p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-medium">Sync conflicts</h2>
          {conflicts.length > 0 && (
            <button
              onClick={async () => {
                await db.conflicts.clear();
                refresh();
              }}
              className="rounded-md bg-slate-700 px-3 py-1 text-xs text-white"
            >
              Clear log
            </button>
          )}
        </div>
        {conflicts.length === 0 ? (
          <p className="text-sm text-slate-500">
            No conflicts. Offline edits replay oldest-first; if the server
            already changed a record (server-wins) the dropped change is
            logged here.
          </p>
        ) : (
          <ul className="space-y-1 text-sm">
            {conflicts.map((c) => (
              <li
                key={c.id}
                className="flex items-center justify-between rounded bg-slate-800/60 px-3 py-2"
              >
                <span>
                  <span className="font-medium uppercase">{c.op}</span>{' '}
                  <span className="text-slate-400">{c.endpoint}</span>
                </span>
                <span className="text-xs text-amber-400">
                  {c.status} · {new Date(c.resolvedAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
