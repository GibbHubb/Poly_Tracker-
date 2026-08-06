import { useCallback, useEffect, useState } from 'react';
import { db, pendingCount, queueMutation, type ConflictRecord } from '../lib/db';
import { replayQueue } from '../lib/sync';
import { useAuthStore } from '../lib/auth';
import { api, type GeoJsonFeature } from '../lib/api';
import {
  deriveRecordUrl,
  diffFields,
  buildMergedPatch,
  GEOMETRY_FIELD,
  type FieldDiff,
} from '../lib/conflictMerge';

interface MergeSession {
  conflict: ConflictRecord;
  server: GeoJsonFeature;
  diffs: FieldDiff[];
  keepServer: Set<string>; // fields the user chose to keep the server's value on
}

function fieldLabel(field: string): string {
  return field === GEOMETRY_FIELD ? 'geometry' : field;
}

function fmtVal(field: string, v: unknown): string {
  if (field === GEOMETRY_FIELD) return '(geometry)';
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function Settings() {
  const [pending, setPending] = useState(0);
  const [conflicts, setConflicts] = useState<ConflictRecord[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const {
    writeToken,
    readToken,
    saveWrite,
    clearWrite,
    saveRead,
    clearRead,
  } = useAuthStore();
  const [writeInput, setWriteInput] = useState(writeToken ?? '');
  const [readInput, setReadInput] = useState(readToken ?? '');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [merge, setMerge] = useState<MergeSession | null>(null);
  const [deleteConflict, setDeleteConflict] = useState<ConflictRecord | null>(null);
  const [busy, setBusy] = useState(false);

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

  // Re-apply a conflict as-is (PT15 blind replay) — used for create/other
  // conflicts that have no server record to diff against.
  const blindReapply = useCallback(
    async (c: ConflictRecord) => {
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
    },
    [refresh],
  );

  // Two-phase Re-apply: fetch current server state, diff, then confirm-merge.
  const startReapply = useCallback(
    async (c: ConflictRecord) => {
      setMsg(null);
      if (c.method === 'DELETE') {
        setDeleteConflict(c);
        return;
      }
      const url = deriveRecordUrl(c.endpoint, c.method);
      if (!url) {
        await blindReapply(c);
        return;
      }
      const mine = (c.payload ?? {}) as {
        properties?: Record<string, unknown>;
        geometry?: unknown;
      };
      try {
        const server = await api.getByPath(url);
        const diffs = diffFields(mine, server);
        if (diffs.length === 0) {
          await db.conflicts.delete(c.id);
          refresh();
          setMsg('Already up to date — nothing to re-apply.');
          return;
        }
        setMerge({ conflict: c, server, diffs, keepServer: new Set() });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (message.includes('404')) {
          setMsg(
            'That record no longer exists on the server. Discard the conflict, or re-create it from the map.',
          );
        } else {
          setMsg(`Could not fetch the current server record: ${message}`);
        }
      }
    },
    [blindReapply, refresh],
  );

  const toggleKeepServer = useCallback((field: string) => {
    setMerge((m) => {
      if (!m) return m;
      const keepServer = new Set(m.keepServer);
      if (keepServer.has(field)) keepServer.delete(field);
      else keepServer.add(field);
      return { ...m, keepServer };
    });
  }, []);

  const confirmMerge = useCallback(async () => {
    if (!merge) return;
    setBusy(true);
    try {
      const mine = (merge.conflict.payload ?? {}) as {
        properties?: Record<string, unknown>;
        geometry?: unknown;
      };
      const patch = buildMergedPatch(mine, merge.server, merge.keepServer);
      // PT18-fu2 — pin the merge to the version it was computed against, not
      // the stale one that caused the conflict. Replaying against the old
      // version would 412 forever; replaying with no precondition at all
      // would clobber a third write that landed while the user was deciding.
      const serverVersion = (merge.server as { properties?: Record<string, unknown> })
        .properties?.version;
      await queueMutation({
        id: merge.conflict.id,
        op: merge.conflict.op,
        endpoint: merge.conflict.endpoint,
        method: 'PATCH',
        payload: patch,
        baseVersion: typeof serverVersion === 'number' ? serverVersion : null,
      });
      await db.conflicts.delete(merge.conflict.id);
      await replayQueue();
      setMerge(null);
      refresh();
      setMsg('Merged and re-applied — check queue for result.');
    } finally {
      setBusy(false);
    }
  }, [merge, refresh]);

  const deleteAnyway = useCallback(
    async (c: ConflictRecord) => {
      await queueMutation({
        id: c.id,
        op: c.op,
        endpoint: c.endpoint,
        method: 'DELETE',
        payload: c.payload,
      });
      await db.conflicts.delete(c.id);
      await replayQueue();
      setDeleteConflict(null);
      refresh();
      setMsg('Delete re-applied — check queue for result.');
    },
    [refresh],
  );

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4">
      <h1 className="text-xl font-semibold">Settings</h1>

      <section className="rounded-lg border border-slate-800 p-4">
        <h2 className="mb-3 font-medium">API access</h2>
        <p className="mb-3 text-sm text-slate-400">
          Write token:{' '}
          {writeToken ? (
            <span className="text-emerald-400">configured</span>
          ) : (
            <span className="text-amber-400">
              not set — writes allowed only if the server gate is disabled
            </span>
          )}
          {'  ·  '}
          Read token:{' '}
          {readToken ? (
            <span className="text-emerald-400">configured</span>
          ) : (
            <span className="text-slate-400">not set (reads open)</span>
          )}
        </p>

        <label className="mb-1 block text-xs text-slate-500">
          Write token — sent on POST/PATCH/DELETE
        </label>
        <div className="mb-3 flex gap-2">
          <input
            type="password"
            value={writeInput}
            onChange={(e) => setWriteInput(e.target.value)}
            placeholder="Write bearer token"
            className="flex-1 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 placeholder-slate-500"
          />
          <button
            onClick={() => saveWrite(writeInput.trim())}
            disabled={!writeInput.trim()}
            className="rounded-md bg-brand px-4 py-1.5 text-sm text-white disabled:opacity-40"
          >
            Save
          </button>
          <button
            onClick={() => {
              clearWrite();
              setWriteInput('');
            }}
            disabled={!writeToken}
            className="rounded-md bg-slate-700 px-4 py-1.5 text-sm text-white disabled:opacity-40"
          >
            Clear
          </button>
        </div>

        <label className="mb-1 block text-xs text-slate-500">
          Read token — sent on GETs (only needed if the server locks reads)
        </label>
        <div className="flex gap-2">
          <input
            type="password"
            value={readInput}
            onChange={(e) => setReadInput(e.target.value)}
            placeholder="Read bearer token (optional)"
            className="flex-1 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 placeholder-slate-500"
          />
          <button
            onClick={() => saveRead(readInput.trim())}
            disabled={!readInput.trim()}
            className="rounded-md bg-brand px-4 py-1.5 text-sm text-white disabled:opacity-40"
          >
            Save
          </button>
          <button
            onClick={() => {
              clearRead();
              setReadInput('');
            }}
            disabled={!readToken}
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
                    onClick={() => void startReapply(c)}
                    disabled={c.payload === undefined}
                    title={
                      c.payload === undefined
                        ? 'No payload captured (pre-PT15 conflict) — cannot merge'
                        : undefined
                    }
                    className="rounded bg-brand px-2 py-0.5 text-xs text-white disabled:opacity-40"
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

      {/* Conflict merge — field-level diff (PT18) */}
      {merge && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="max-h-[85vh] w-full max-w-lg overflow-auto rounded-lg border border-slate-700 bg-slate-900 p-4">
            <h3 className="mb-1 font-medium">Review changes before re-applying</h3>
            <p className="mb-3 text-xs text-slate-400">
              {merge.conflict.endpoint}. For each field, choose whether to push
              your value or keep the server&apos;s. Fields not listed are
              unchanged and stay as the server has them.
            </p>
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="text-left text-slate-500">
                  <th className="py-1 pr-2">Field</th>
                  <th className="py-1 pr-2">Yours</th>
                  <th className="py-1 pr-2">Server</th>
                  <th className="py-1 pr-2 text-right">Keep server</th>
                </tr>
              </thead>
              <tbody>
                {merge.diffs.map((d) => {
                  const keep = merge.keepServer.has(d.field);
                  return (
                    <tr key={d.field} className="border-t border-slate-800 align-top">
                      <td className="py-1.5 pr-2 font-medium text-slate-300">
                        {fieldLabel(d.field)}
                      </td>
                      <td
                        className={`py-1.5 pr-2 ${keep ? 'text-slate-500 line-through' : 'text-emerald-400'}`}
                      >
                        {fmtVal(d.field, d.mine)}
                      </td>
                      <td
                        className={`py-1.5 pr-2 ${keep ? 'text-emerald-400' : 'text-slate-500'}`}
                      >
                        {fmtVal(d.field, d.server)}
                      </td>
                      <td className="py-1.5 pr-2 text-right">
                        <input
                          type="checkbox"
                          checked={keep}
                          onChange={() => toggleKeepServer(d.field)}
                          className="h-4 w-4 accent-brand"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setMerge(null)}
                disabled={busy}
                className="rounded-md bg-slate-700 px-4 py-1.5 text-sm text-white disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={() => void confirmMerge()}
                disabled={busy}
                className="rounded-md bg-brand px-4 py-1.5 text-sm text-white disabled:opacity-40"
              >
                Re-apply merged
              </button>
            </div>
          </div>
        </div>
      )}

      {/* DELETE conflict — no fields to diff */}
      {deleteConflict && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-lg border border-slate-700 bg-slate-900 p-4">
            <h3 className="mb-1 font-medium">Re-apply a delete?</h3>
            <p className="mb-4 text-xs text-slate-400">
              {deleteConflict.endpoint}. This was a queued delete the server
              rejected. There are no fields to merge — you can re-send the
              delete (it will no-op if the record is already gone) or discard
              the conflict.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteConflict(null)}
                className="rounded-md bg-slate-700 px-4 py-1.5 text-sm text-white"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  await db.conflicts.delete(deleteConflict.id);
                  setDeleteConflict(null);
                  refresh();
                }}
                className="rounded-md bg-slate-700 px-4 py-1.5 text-sm text-white"
              >
                Discard
              </button>
              <button
                onClick={() => void deleteAnyway(deleteConflict)}
                className="rounded-md bg-red-600 px-4 py-1.5 text-sm text-white"
              >
                Delete anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
