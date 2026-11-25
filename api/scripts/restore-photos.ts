/**
 * PT47 — put a backup-photos.ts folder back into a bucket (or a local folder), and prove it landed.
 *
 *   cd api
 *   # drill: a THROWAWAY bucket, created by hand first (docs/security/operations.md 1.7)
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npx tsx scripts/restore-photos.ts \
 *     --from ../backups/photos-<date> --bucket poly-photos-restore-<date>
 *   # fully local drill: into a folder a local API can serve
 *   npx tsx scripts/restore-photos.ts --from ../backups/photos-<date> --dir /tmp/poly-restore-photos
 *
 * Every file is checked against manifest.json (bytes + sha256) before upload. Nothing is ever
 * overwritten: an object already in the target is counted, not replaced. The production bucket
 * (SUPABASE_PHOTO_BUCKET, default poly-photos) is refused unless --into-production.
 * Exit 0 = every manifest object is in the target; 1 = anything else; 2 = bad arguments.
 */
import { resolve } from 'node:path';
import {
  checkRestoreBucket,
  createDiskRestoreTarget,
  createSupabaseRestoreTarget,
  restorePhotos,
  type RestoreTarget,
} from '../src/lib/photoBackup.js';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

const from = opt('--from');
const bucket = opt('--bucket');
const dir = opt('--dir');
if (!from || (!bucket && !dir) || (bucket && dir)) {
  console.error('Usage: restore-photos.ts --from <backup folder> (--bucket <throwaway bucket> | --dir <folder>) [--into-production]');
  process.exit(2);
}

let target: RestoreTarget;
if (bucket) {
  if (!process.env.SUPABASE_PHOTO_BUCKET) {
    console.warn(
      'SUPABASE_PHOTO_BUCKET is not set: the production-bucket guard compares against the default, poly-photos. ' +
        'If production uses another bucket, set SUPABASE_PHOTO_BUCKET to it so the guard protects it.',
    );
  }
  const refusal = checkRestoreBucket(
    bucket,
    process.env.SUPABASE_PHOTO_BUCKET ?? 'poly-photos',
    args.includes('--into-production'),
  );
  if (refusal) {
    console.error(refusal);
    process.exit(2);
  }
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for --bucket.');
    process.exit(2);
  }
  target = createSupabaseRestoreTarget({ url, serviceKey, bucket });
} else {
  target = createDiskRestoreTarget(resolve(dir!));
}

try {
  console.log(`→ ${resolve(from)} → ${target.description}`);
  const r = await restorePhotos(target, { fromDir: resolve(from), log: (line) => console.log(line) });
  console.log(
    `${r.created} restored · ${r.existed} already there (left as they were, size checked below) · ` +
      `${r.corrupt.length} corrupt in the backup · ${r.failed.length} failed · ` +
      `${r.absent.length} not in the target afterwards · ${r.sizeMismatch.length} wrong size in the target`,
  );
  for (const f of r.corrupt) console.log(`  CORRUPT (size/sha256 differ from manifest) ${f}`);
  for (const f of r.failed) console.log(`  FAILED ${f.file}: ${f.error}`);
  for (const f of r.absent) console.log(`  ABSENT ${f}`);
  for (const m of r.sizeMismatch) {
    console.log(`  WRONG SIZE ${m.file}: target ${m.actual ?? 'reports no size'}, manifest ${m.expected}`);
  }
  if (r.ok) {
    console.log(
      `✓ every manifest object is in ${target.description} at the manifest's size ` +
        `(${r.created} restored, ${r.existed} already there and size-verified)`,
    );
  }
  else process.exitCode = 1;
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
