/**
 * PT27 — list (and with --apply, remove) stored photo objects no `photos` row claims.
 *
 *   DATABASE_URL=… PHOTO_BACKEND=… npx tsx scripts/sweep-photos.ts            # dry run: counts + keys
 *   DATABASE_URL=… PHOTO_BACKEND=… npx tsx scripts/sweep-photos.ts --apply    # remove them
 *
 * Uses the same env as the API (DATABASE_URL; PHOTO_BACKEND and its storage vars), so it looks
 * at exactly the store the deployment writes to. See src/lib/photoSweep.ts for the two guards:
 * a one-day age floor, and a refusal to apply against an empty `photos` table.
 *
 * Options: --apply · --allow-empty-table · --min-age-hours <n> (default 24)
 */
import { createPhotoStore } from '../src/storage/index.js';
import { pool, query } from '../src/db.js';
import { sweepOrphanPhotos } from '../src/lib/photoSweep.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const hoursAt = args.indexOf('--min-age-hours');
const minAgeHours = hoursAt >= 0 ? Number(args[hoursAt + 1]) : 24;
if (!Number.isFinite(minAgeHours) || minAgeHours < 1) {
  console.error('--min-age-hours must be a number of hours, at least 1.');
  process.exit(2);
}

const store = createPhotoStore();
if (store.unavailable) {
  console.error(`Photo storage is not usable here: ${store.unavailable}`);
  process.exit(2);
}

try {
  const { rows } = await query<{ path: string }>('SELECT path FROM photos');
  const result = await sweepOrphanPhotos(
    store,
    rows.map((r) => r.path),
    { apply: flag('--apply'), allowEmptyTable: flag('--allow-empty-table'), minAgeMs: minAgeHours * 3600_000 },
  );
  console.log(
    `${store.kind} store: ${result.stored} object(s), ${result.claimed} claimed by a row, ` +
      `${result.orphans.length} orphan(s) older than ${minAgeHours} h, ${result.tooNew} newer (left alone).`,
  );
  for (const key of result.orphans) console.log(`  orphan: ${key}`);
  console.log(result.applied ? `Removed ${result.removed}.` : 'Dry run: nothing removed. Add --apply to remove them.');
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
