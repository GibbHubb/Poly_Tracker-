import { db, type PendingMutation } from './db';
import { getWriteToken } from './auth';
import { replayPhotoQueue } from './photoQueue';

const BASE = import.meta.env.VITE_API_BASE || '/api';

export interface SyncResult {
  replayed: number;
  conflicts: PendingMutation[];
}

let running = false;

/**
 * Replay queued mutations oldest-first. Conflict policy = server-wins:
 * a 409/412 is logged and the mutation is dropped (kept in `conflicts` for a
 * future resolution UI). Network errors abort the run and keep the queue.
 */
export async function replayQueue(): Promise<SyncResult> {
  if (running) return { replayed: 0, conflicts: [] };
  running = true;
  const conflicts: PendingMutation[] = [];
  let replayed = 0;
  try {
    const queue = await db.pending.orderBy('createdAt').toArray();
    for (const m of queue) {
      try {
        // Replay is always mutations → write token.
        const token = getWriteToken();
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        // PT18-fu2 — replay against the version the edit was made on. This is
        // what makes the 409/412 branch below reachable organically: without
        // it the server has no precondition to fail and every replay wins.
        if (m.baseVersion != null) headers['If-Match'] = `"${m.baseVersion}"`;
        const res = await fetch(`${BASE}${m.endpoint}`, {
          method: m.method,
          headers,
          body: m.method === 'DELETE' ? undefined : JSON.stringify(m.payload),
        });
        if (res.ok) {
          await db.pending.delete(m.id);
          replayed += 1;
        } else if (res.status === 409 || res.status === 412) {
          console.warn('[sync] server-wins conflict, dropping', m.id);
          conflicts.push(m);
          await db.conflicts.put({
            id: m.id,
            op: m.op,
            endpoint: m.endpoint,
            method: m.method,
            status: res.status,
            resolvedAt: Date.now(),
            payload: m.payload,
          });
          await db.pending.delete(m.id);
        } else {
          // 4xx/5xx that isn't a conflict — stop and retry later.
          break;
        }
      } catch {
        // offline again — stop, keep remaining queue intact.
        break;
      }
    }
  } finally {
    running = false;
  }
  return { replayed, conflicts };
}

/** PT28 — how often queued photos are retried while the browser believes it is online. */
export const PHOTO_RETRY_MS = 30_000;

export function startAutoSync(): () => void {
  // PT28 — photos drain after the JSON edits, but do not depend on them succeeding.
  const handler = () => {
    void replayQueue()
      .catch((err) => console.warn('[sync] edit replay failed', err))
      .finally(() => void replayPhotoQueue().catch((err) => console.warn('[sync] photo replay failed', err)));
  };
  window.addEventListener('online', handler);
  if (navigator.onLine) handler();
  // Weak signal often never flips navigator.onLine, so no 'online' event ever fires: retry on a timer.
  const timer = window.setInterval(() => {
    if (navigator.onLine) void replayPhotoQueue().catch(() => undefined);
  }, PHOTO_RETRY_MS);
  return () => {
    window.removeEventListener('online', handler);
    window.clearInterval(timer);
  };
}
