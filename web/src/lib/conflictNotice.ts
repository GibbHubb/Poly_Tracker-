// PT40 — tell the user, where they are, that a save was refused.
//
// A stale save (409/412) used to vanish from the map: the edit dialog closed,
// the reload showed the other person's edit, and the only trace was a row in
// Settings → Sync conflicts that nobody knew to open. Every place that files a
// conflict now goes through `recordConflict`, which stores it AND raises a
// notice; <ConflictToast/> (mounted once in App) renders that notice on
// whatever page is open, with a button into the review dialog.

import { create } from 'zustand';
import { db, type ConflictRecord } from './db';

export interface ConflictNotice {
  /** The conflict the "Review" button opens (the most recent one). */
  conflictId: string;
  endpoint: string;
  /** Conflicts raised since the notice was last dismissed. */
  count: number;
}

interface ConflictNoticeState {
  notice: ConflictNotice | null;
  notify: (conflictId: string, endpoint: string) => void;
  dismiss: () => void;
}

export const useConflictNotice = create<ConflictNoticeState>((set) => ({
  notice: null,
  notify: (conflictId, endpoint) =>
    set((s) => ({
      notice: { conflictId, endpoint, count: (s.notice?.count ?? 0) + 1 },
    })),
  dismiss: () => set({ notice: null }),
}));

/** Store a refused write in the conflict log and raise the on-screen notice. */
export async function recordConflict(c: ConflictRecord): Promise<void> {
  await db.conflicts.put(c);
  useConflictNotice.getState().notify(c.id, c.endpoint);
}

/** Human name of the record an endpoint points at, for the notice text. */
export function recordKind(endpoint: string): string {
  if (endpoint.includes('/poly-runs')) return 'poly run';
  if (endpoint.includes('/paddocks')) return 'paddock';
  if (endpoint.includes('/features')) return 'feature';
  if (endpoint.startsWith('/farms')) return 'farm';
  return 'record';
}

/** Route that opens the merge review for one conflict (Settings reads `?conflict=`). */
export function conflictReviewPath(conflictId: string): string {
  return `/settings?conflict=${encodeURIComponent(conflictId)}`;
}
