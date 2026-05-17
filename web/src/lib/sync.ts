import { db, type PendingMutation } from './db';

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
        const res = await fetch(`${BASE}${m.endpoint}`, {
          method: m.method,
          headers: { 'Content-Type': 'application/json' },
          body: m.method === 'DELETE' ? undefined : JSON.stringify(m.payload),
        });
        if (res.ok) {
          await db.pending.delete(m.id);
          replayed += 1;
        } else if (res.status === 409 || res.status === 412) {
          console.warn('[sync] server-wins conflict, dropping', m.id);
          conflicts.push(m);
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

export function startAutoSync(): () => void {
  const handler = () => {
    void replayQueue();
  };
  window.addEventListener('online', handler);
  if (navigator.onLine) handler();
  return () => window.removeEventListener('online', handler);
}
