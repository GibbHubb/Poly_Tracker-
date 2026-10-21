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
 */
export const DEFAULT_MIN_AGE_MS = 24 * 60 * 60 * 1000;

export interface SweepOptions {
  apply: boolean;
  minAgeMs?: number;
  allowEmptyTable?: boolean;
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
    if (now - o.modifiedAt.getTime() < minAge) tooNew++;
    else orphans.push(o.key);
  }

  const result: SweepResult = {
    stored: objects.length,
    claimed: claimed.size,
    orphans,
    tooNew,
    removed: 0,
    applied: false,
  };
  if (!opts.apply || orphans.length === 0) return result;
  if (claimed.size === 0 && !opts.allowEmptyTable) throw new EmptyTableRefusal(objects.length);

  for (const key of orphans) {
    await store.remove(key);
    result.removed++;
  }
  result.applied = true;
  return result;
}
