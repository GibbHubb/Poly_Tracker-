/**
 * PT47 — download every stored photo object to a local dated folder, and check it against `photos`.
 *
 *   cd api
 *   DATABASE_URL=… PGSSL=true PHOTO_BACKEND=supabase SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
 *     npx tsx scripts/backup-photos.ts [--out ../backups/photos-<YYYY-MM-DD>]
 *
 * Same env as the API, so it reads exactly the store the deployment writes to. Read-only against
 * storage (list + read; see src/lib/photoBackup.ts). Re-running with the same --out resumes: files
 * already there at the listed size are kept. Exit 0 = every `photos` row has its bytes in the folder
 * and the folder's count and bytes match manifest.json; 1 = anything else; 2 = not configured.
 */
import { resolve } from 'node:path';
import { createPhotoStore } from '../src/storage/index.js';
import { backupPhotos } from '../src/lib/photoBackup.js';

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const today = new Date().toISOString().slice(0, 10);
const outDir = resolve(outAt >= 0 && args[outAt + 1] ? args[outAt + 1]! : `../backups/photos-${today}`);

const store = createPhotoStore();
if (store.unavailable) {
  console.error(`Photo storage is not usable here: ${store.unavailable}`);
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set: the backup is checked against the photos table.');
  process.exit(2);
}
// db.js connects on import, so it comes after the config checks.
const { pool, query } = await import('../src/db.js');

try {
  const { rows } = await query<{ path: string }>('SELECT path FROM photos');
  console.log(`→ ${store.kind} store → ${outDir}`);
  const r = await backupPhotos(
    store,
    rows.map((row) => row.path),
    { outDir, log: (line) => console.log(line) },
  );
  const m = r.manifest;
  console.log(
    `${r.listed} listed · ${r.downloaded} downloaded · ${r.skipped} already here · ${r.failed.length} failed`,
  );
  console.log(
    `folder: ${r.filesOnDisk} file(s), ${r.bytesOnDisk} bytes · manifest: ${m.objects.length} object(s) · ` +
      `photos rows: ${m.dbRows} · missing: ${m.missing.length} · unclaimed (orphans): ${m.unclaimed.length}`,
  );
  for (const f of r.failed) console.log(`  FAILED ${f.key}: ${f.error}`);
  for (const k of m.missing) console.log(`  MISSING (row without bytes) ${k}`);
  if (r.ok) {
    console.log(`✓ ${outDir}`);
  } else {
    console.error('FAILED: the backup is incomplete. Re-run with the same --out to resume.');
    process.exitCode = 1;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
