import type { PhotoStore } from '../storage/index.js';

/**
 * PT27 — reclaim stored photo objects that no `photos` row points at.
 *
 * PT24 stores the bytes BEFORE the row on purpose (a row pointing at a missing
 * object is a broken image with no way to tell), so a failed insert leaves an
 * object behind. This finds those: an object whose key no `photos.path` claims
 * and that is older than `minAgeMs`.
 *
 * ⚠️ The age floor is what keeps this safe beside live uploads: an object put a
 * moment ago may be waiting for its INSERT. A day is far past any request.
 *
 * ⚠️ Dry run unless `apply` is set, and `apply` is refused when the table claims
 * NOTHING while the store holds objects, unless `allowEmptyTable` says that is
 * really so. An empty `claimed` set is also what a sweep pointed at the wrong
 * database looks like, and then every photo in the bucket is an "orphan".
 *
 * PT44 — two more refusals on `apply`, for a table that is NOT empty but still
 * describes a different store:
 *   - no listed key is claimed at all while both sides are non-empty (e.g.
 *     PHOTO_BACKEND=disk against a DB of Supabase object keys: absolute paths and
 *     bare names never match). Not overridable: that is a misconfiguration, never
 *     a clean-up.
 *   - more than half of the listed objects are unclaimed. Orphans only come from
 *     an INSERT failing after a successful put, or a best-effort remove failing,
 *     so in a working deployment they are a small minority. A mostly-unclaimed
 *     store is a wrong database, a restored backup or a half-finished migration,
 *     and a human should look first. Half (not, say, 10 %) so a tiny store with
 *     one orphan beside one photo still sweeps without the flag;
 *     `allowMostlyUnclaimed` (--allow-mostly-unclaimed) is the override.
 * And an object whose time is missing or unparseable is too new, never old.
 */
export const DEFAULT_MIN_AGE_MS = 24 * 60 * 60 * 1000;
/** PT44 — more than this share of listed objects unclaimed refuses `apply`. */
export const MAX_UNCLAIMED_SHARE = 0.5;

export interface SweepOptions {
  apply: boolean;
  minAgeMs?: number;
  allowEmptyTable?: boolean;
  allowMostlyUnclaimed?: boolean;
  now?: Date;
}

export interface SweepResult {
  stored: number;
  claimed: number;
  /** Unclaimed and old enough: removed when applied, listed when not. */
  orphans: string[];
  /** Unclaimed but younger than the floor: left alone this run. */
  tooNew: number;
  removed: number;
  applied: boolean;
  /** PT44 — on a dry run, the refusal an `apply` would hit (null when it would proceed). */
  wouldRefuse: string | null;
}

export class EmptyTableRefusal extends Error {
  constructor(stored: number) {
    super(
      `photos holds no rows but the store holds ${stored} object(s). That is also what a sweep ` +
        'against the wrong database looks like; nothing was removed. Re-run with allowEmptyTable ' +
        '(--allow-empty-table) only if the table really is empty.',
    );
    this.name = 'EmptyTableRefusal';
  }
}

export class BackendMismatchRefusal extends Error {
  constructor(stored: number, claimed: number) {
    super(
      `The store holds ${stored} object(s) and photos claims ${claimed} key(s), but not one key appears ` +
        'in both. The store and the database are not the same deployment (check PHOTO_BACKEND and ' +
        'DATABASE_URL); nothing was removed.',
    );
    this.name = 'BackendMismatchRefusal';
  }
}

export class MostlyUnclaimedRefusal extends Error {
  constructor(stored: number, unclaimed: number) {
    super(
      `${unclaimed} of ${stored} stored object(s) are claimed by no row: more than half the store. ` +
        'That looks like the wrong database or a half-finished migration; nothing was removed. ' +
        'Re-run with allowMostlyUnclaimed (--allow-mostly-unclaimed) only if they really are orphans.',
    );
    this.name = 'MostlyUnclaimedRefusal';
  }
}

export async function sweepOrphanPhotos(
  store: Pick<PhotoStore, 'list' | 'remove'>,
  claimedPaths: Iterable<string>,
  opts: SweepOptions,
): Promise<SweepResult> {
  const claimed = new Set(claimedPaths);
  const now = (opts.now ?? new Date()).getTime();
  const minAge = opts.minAgeMs ?? DEFAULT_MIN_AGE_MS;
  const objects = await store.list();

  const orphans: string[] = [];
  let tooNew = 0;
  for (const o of objects) {
    if (claimed.has(o.key)) continue;
    // PT44 — an unknown age (missing/unparseable time → NaN) is never "old":
    // `now - NaN < minAge` is false, which used to make it an orphan.
    const t = o.modifiedAt instanceof Date ? o.modifiedAt.getTime() : Number.NaN;
    if (!Number.isFinite(t) || now - t < minAge) tooNew++;
    else orphans.push(o.key);
  }

  const unclaimed = orphans.length + tooNew;
  const refusal = (): Error | null => {
    if (claimed.size === 0) return opts.allowEmptyTable ? null : new EmptyTableRefusal(objects.length);
    if (objects.length > 0 && unclaimed === objects.length) {
      return new BackendMismatchRefusal(objects.length, claimed.size);
    }
    if (unclaimed > objects.length * MAX_UNCLAIMED_SHARE && !opts.allowMostlyUnclaimed) {
      return new MostlyUnclaimedRefusal(objects.length, unclaimed);
    }
    return null;
  };

  const result: SweepResult = {
    stored: objects.length,
    claimed: claimed.size,
    orphans,
    tooNew,
    removed: 0,
    applied: false,
    wouldRefuse: null,
  };
  if (orphans.length === 0) return result;
  const refused = refusal();
  if (!opts.apply) {
    result.wouldRefuse = refused?.message ?? null;
    return result;
  }
  if (refused) throw refused;

  for (const key of orphans) {
    await store.remove(key);
    result.removed++;
  }
  result.applied = true;
  return result;
}
