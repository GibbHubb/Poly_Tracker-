import { useCallback, useEffect, useState } from 'react';
import { db, pendingCount, queueMutation, type ConflictRecord } from '../lib/db';
import { replayQueue } from '../lib/sync';
import { useAuthStore } from '../lib/auth';

export function Settings() {
  const [pending, setPending] = useState(0);
  const [conflicts, setConflicts] = useState<ConflictRecord[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const { token, save: saveToken, clear: clearToken } = useAuthStore();
  const [tokenInput, setTokenInput] = useState(token ?? '');
  const [expanded, setExpanded] = useState<string | null>(null);

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
        <h2 className="mb-3 font-medium">API access</h2>
        <p className="mb-3 text-sm text-slate-400">
          Token:{' '}
          {token ? (
            <span className="text-emerald-400">configured</span>
          ) : (
            <span className="text-amber-400">not set — writes allowed only if the server gate is disabled</span>
          )}
        </p>
        <div className="flex gap-2">
          <input
            type="password"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="Bearer token"
            className="flex-1 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 placeholder-slate-500"
          />
          <button
            onClick={() => saveToken(tokenInput.trim())}
            disabled={!tokenInput.trim()}
            className="rounded-md bg-brand px-4 py-1.5 text-sm text-white disabled:opacity-40"
          >
            Save
          </button>
          <button
            onClick={() => { clearToken(); setTokenInput(''); }}
            disabled={!token}
            className="rounded-md bg-slate-700 px-4 py-1.5 text-sm text-white disabled:opacity-40"
          >
            Clear
          </button>
        </div>
      </section>

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
          <ul className="space-y-2 text-sm">
            {conflicts.map((c) => (
              <li key={c.id} className="rounded bg-slate-800/60 px-3 py-2">
                <div className="flex items-center justify-between">
                  <span>
                    <span className="font-medium uppercase">{c.op}</span>{' '}
                    <span className="text-slate-400">{c.endpoint}</span>
                  </span>
                  <span className="text-xs text-amber-400">
                    {c.status} · {new Date(c.resolvedAt).toLocaleString()}
                  </span>
                </div>
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => setExpanded(expanded === c.id ? null : c.id)}
                    className="rounded bg-slate-700 px-2 py-0.5 text-xs text-slate-300"
                  >
                    {expanded === c.id ? 'Hide' : 'View'} payload
                  </button>
                  <button
                    onClick={async () => {
                      await queueMutation({
                        id: c.id,
                        op: c.op,
                        endpoint: c.endpoint,
                        method: c.method,
                        payload: c.payload,
                      });
                      await db.conflicts.delete(c.id);
                      await replayQueue();
                      refresh();
                      setMsg('Re-applied — check queue for result.');
                    }}
                    className="rounded bg-brand px-2 py-0.5 text-xs text-white"
                  >
                    Re-apply
                  </button>
                  <button
                    onClick={async () => {
                      await db.conflicts.delete(c.id);
                      refresh();
                    }}
                    className="rounded bg-slate-700 px-2 py-0.5 text-xs text-slate-300"
                  >
                    Discard
                  </button>
                </div>
                {expanded === c.id && (
                  <pre className="mt-2 max-h-40 overflow-auto rounded bg-slate-900 p-2 text-xs text-slate-300">
                    {c.payload !== undefined
                      ? JSON.stringify(c.payload, null, 2)
                      : 'payload not captured (pre-PT15 conflict)'}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
