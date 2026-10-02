import { db, type PendingMutation } from './db';
import { getWriteToken } from './auth';
import { replayPhotoQueue } from './photoQueue';
import { recordConflict } from './conflictNotice';
import { ApiError } from './api';
import { describeError, notify, shouldQueue } from './notify';

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
  // PT35 — rows the server refused outright, set aside so they stop blocking the queue.
  let refused = 0;
  let firstRefusal: ApiError | null = null;
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
          // PT40 — recordConflict also raises the on-screen notice.
          await recordConflict({
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
          // An unreadable body still leaves the status to report.
          const err = new ApiError(res.status, await res.text().catch(() => ''));
          if (!shouldQueue(err)) {
            // PT35 — a 400/404/422 will get the same answer every time. It used to
            // `break` here and hold every edit behind it forever. Set it aside in
            // the conflict log (Settings → Sync conflicts can discard or re-apply
            // it) and carry on with the rest.
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
            refused += 1;
            firstRefusal ??= err;
            continue;
          }
          // 5xx / auth: may clear up — stop, keep the queue, and say so (PT35):
          // the only sign used to be a pending count that never went down.
          const left = queue.length - replayed - conflicts.length - refused;
          notify(
            'error',
            describeError(`Syncing ${left} saved edit${left === 1 ? '' : 's'}`, err) +
              ' They stay on this device and sync will try again.',
          );
          break;
        }
      } catch {
        // Silent on purpose (PT35): the connection dropped mid-replay. That is
        // the normal offline case, not a fault; the queue is kept, the status
        // badge shows the pending count, and the next 'online' event retries.
        break;
      }
    }
  } finally {
    running = false;
  }
  if (refused > 0) {
    notify(
      'error',
      `${refused} saved edit${refused === 1 ? ' was' : 's were'} refused by the server and set aside (Settings → Sync conflicts). ` +
        describeError('First refusal', firstRefusal),
    );
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
    // Silent on purpose (PT35): a timer retry while signal is weak is expected to
    // fail often; replayPhotoQueue records real refusals on the photo itself.
    if (navigator.onLine) void replayPhotoQueue().catch(() => undefined);
  }, PHOTO_RETRY_MS);
  return () => {
    window.removeEventListener('online', handler);
    window.clearInterval(timer);
  };
}
