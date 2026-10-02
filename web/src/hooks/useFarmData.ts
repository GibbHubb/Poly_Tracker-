// PT29 — one definition of "the farm on screen": last server copy + queued edits.
//
// Before: FarmMap.reload() was four network calls, and offline they failed and
// the map showed satellite imagery with nothing on it. Now the farm's last
// server copy lives in IndexedDB (written on every successful load) and is
// shown first; the network replaces it when it answers; and the user's own
// queued edits are drawn on top until the server has them.
//
// Three rules keep the copy honest (review findings, 2026-10-02):
//  - only the LATEST load may land, and only for the farm still on screen;
//  - an answer the service worker served from its cache is labelled "cache",
//    never stored as fresh;
//  - a failed refresh with a copy in hand is still reported (PT35), not hidden.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { liveQuery } from 'dexie';
import { api, type GeoJsonFeatureCollection } from '../lib/api';
import { db, type CachedFarmData, type PendingMutation } from '../lib/db';
import { applyPending, pendingForFarm, type FarmCollections } from '../lib/pendingOverlay';
import { describeError, isNetworkError } from '../lib/notify';

const EMPTY: GeoJsonFeatureCollection = { type: 'FeatureCollection', features: [] };
const EMPTY_BASE: FarmCollections = { paddocks: EMPTY, polyRuns: EMPTY, features: EMPTY };

/** After the queue shrinks, wait for the replay to settle before one refresh. */
export const DRAIN_REFRESH_MS = 400;

export interface FarmData extends FarmCollections {
  farm: CachedFarmData['farm'] | null;
  /** 'cache' = the device's (or service worker's) copy; 'network' = fresh from the server. */
  source: 'none' | 'cache' | 'network';
  /** When the shown copy came from the server (ms epoch); null if unknown. */
  fetchedAt: number | null;
  /** Nothing to show, and why. */
  loadError: string | null;
  /** A copy IS shown, but refreshing it failed, and why. */
  refreshError: string | null;
  /** Queued edits for this farm still waiting to reach the server. */
  pendingCount: number;
  /** Fetch from the server and refresh the snapshot. Rejects on failure. */
  reload: () => Promise<void>;
}

async function fetchFarm(farmId: string): Promise<{ data: CachedFarmData; fromCache: boolean }> {
  const { farm, paddocks, polyRuns, features, fromCache } = await api.loadFarm(farmId);
  return { data: { farmId, farm, paddocks, polyRuns, features, fetchedAt: Date.now() }, fromCache };
}

function refreshFailedText(err: unknown): string {
  if (!isNetworkError(err)) return describeError('Refreshing this farm', err);
  return 'Could not reach the server; showing the copy on this device.';
}

export function useFarmData(farmId: string): FarmData {
  const [snapState, setSnap] = useState<CachedFarmData | null>(null);
  // A copy belonging to another farm is never shown (navigation mid-load).
  const snap = snapState?.farmId === farmId ? snapState : null;
  const [source, setSource] = useState<FarmData['source']>('none');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingMutation[]>([]);

  const farmRef = useRef(farmId);
  farmRef.current = farmId;
  const snapRef = useRef<CachedFarmData | null>(null);
  snapRef.current = snap;
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    const forFarm = farmId;
    const offline = navigator.onLine === false;
    // Offline with a device copy there is nothing to fetch; the service worker's
    // answer would only be an older, unlabelled copy.
    if (offline && snapRef.current?.farmId === forFarm) throw new TypeError('offline');
    const { data, fromCache } = await fetchFarm(forFarm);
    // Superseded by a newer load, or the user has moved to another farm.
    if (mine !== seq.current || farmRef.current !== forFarm) return;
    if (offline || fromCache) {
      // Keep the device copy's age if we have one; otherwise the age is unknown.
      const prev = snapRef.current?.farmId === forFarm ? snapRef.current.fetchedAt : 0;
      setSnap({ ...data, fetchedAt: prev });
      setSource('cache');
      setLoadError(null);
      // Online but the server did not answer in time: say so, rather than a
      // banner promising a refresh that is not happening.
      if (!offline) setRefreshError(refreshFailedText(new TypeError('cache fallback')));
      return;
    }
    setSnap(data);
    setSource('network');
    setLoadError(null);
    setRefreshError(null);
    // A full disk must not turn a successful load into a failure.
    await db.farmData.put(data).catch((err: unknown) => console.warn('[farmData] snapshot not saved', err));
  }, [farmId]);

  useEffect(() => {
    let alive = true;
    setSnap(null);
    setSource('none');
    setLoadError(null);
    setRefreshError(null);
    void (async () => {
      const cached = await db.farmData.get(farmId).catch(() => undefined);
      if (!alive) return;
      if (cached) {
        snapRef.current = cached;
        setSnap(cached);
        setSource('cache');
        if (navigator.onLine === false) return;
      }
      try {
        await reload();
      } catch (err) {
        if (!alive) return;
        if (cached) {
          setRefreshError(refreshFailedText(err));
          return;
        }
        setLoadError(
          !isNetworkError(err)
            ? describeError('Loading this farm', err)
            : navigator.onLine === false
              ? 'No offline copy of this farm on this device. Open it once while online to keep a copy.'
              : 'Could not reach the server, and there is no offline copy of this farm on this device.',
        );
      }
    })();
    return () => {
      alive = false;
    };
  }, [farmId, reload]);

  // The queue, live: a draw/rename/delete made offline shows the moment it is queued.
  useEffect(() => {
    const sub = liveQuery(() => db.pending.orderBy('createdAt').toArray()).subscribe({
      next: setPending,
      error: (err: unknown) => console.warn('[farmData] pending queue unreadable', err),
    });
    return () => sub.unsubscribe();
  }, []);

  // When this farm's queued edits drain, the server has them: fetch the real rows
  // so the overlay copy is replaced, not lost. Debounced: a replay deletes queue
  // rows one by one, and one refresh after it settles beats one per row racing.
  //
  // The timer lives in a ref and is only ever RESET by a further drain, never
  // cancelled by the queue growing (review finding: a new edit queued within the
  // debounce window used to cancel the refresh for the rows that had drained).
  const mineCount = pendingForFarm(pending, farmId);
  const prev = useRef({ farmId, count: mineCount });
  const drainTimer = useRef<number | null>(null);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    const was = prev.current;
    prev.current = { farmId, count: mineCount };
    if (was.farmId !== farmId || mineCount >= was.count) return;
    if (drainTimer.current !== null) window.clearTimeout(drainTimer.current);
    drainTimer.current = window.setTimeout(() => {
      drainTimer.current = null;
      reloadRef.current().catch((err: unknown) => setRefreshError(refreshFailedText(err)));
    }, DRAIN_REFRESH_MS);
  }, [mineCount, farmId]);
  // Only leaving the farm (or unmounting) cancels a scheduled refresh.
  useEffect(
    () => () => {
      if (drainTimer.current !== null) window.clearTimeout(drainTimer.current);
      drainTimer.current = null;
    },
    [farmId],
  );

  const shown = useMemo(
    () => applyPending(snap ?? EMPTY_BASE, pending, farmId),
    [snap, pending, farmId],
  );
  return {
    ...shown,
    farm: snap?.farm ?? null,
    source: snap ? source : 'none',
    fetchedAt: snap?.fetchedAt || null,
    loadError,
    refreshError,
    pendingCount: mineCount,
    reload,
  };
}
