# Security operations runbook

Written by **PT43**. Two jobs the code cannot do for itself: proving the data can be brought back, and
changing the secrets on a schedule. Both are **Max / ops** jobs: this page says exactly how, PT43 did not run
them. Record every run in the log tables at the bottom; an empty log means it has never been done.

Everything here touches the **shared** Supabase project (Our_Menu lives in `public`, Cortana in `cortana`).
Every command below is scoped to the `poly` schema or to Poly Tracker's own settings. Do not widen one.

---

## 1. Backup and restore drill (`poly` schema + photo bytes)

**Schedule:** a dump before every migration, and at least **monthly** while there is real data. Since PT47 the
`Backup` GitHub Action (1.8) takes both halves every Monday; the manual steps below are the same commands, for
before a migration and for the drill. A restore drill (steps 1.2 to 1.4 for rows, 1.7 for photos) **once now**,
then **every 6 months**, and after any change to `db/init`, `db/migrations` or `api/src/storage/`.
A backup that has never been restored is a hope, not a backup.

A backup is **two halves taken together**: the `poly` dump (1.1, the rows, including `photos.path`) and the photo
bucket (1.6, the bytes those paths name). Either alone restores broken photos, or bytes nothing points at.

The Supabase free plan's own daily backups are not relied on (no point-in-time restore, short retention, and a
restore there rolls back the whole shared project, other apps included).

### 1.1 Take a dump

From the repo root, in Git Bash. `POLY_TRACKER_DATABASE_URL` is in `backlog_bandit/.env`.

```bash
export POLY_TRACKER_DATABASE_URL='postgresql://poly_app.<project-ref>:<password>@aws-1-eu-west-1.pooler.supabase.com:5432/postgres'
scripts/backup_poly_schema.sh backups
```

The script (PT30) dumps only `--schema=poly`, with no `--clean`/`--create`, and refuses to publish a 0-byte,
truncated or table-less dump. It prints `✓ backups/poly_schema_<stamp>.sql`, the byte count, the number of
`CREATE TABLE` and `COPY` blocks. `backups/` is gitignored: **copy the file somewhere that is not this laptop**
(Max's Google Drive is fine; the dump holds farm names and photo locations, so not a public place).

Note the live row counts at the same moment, for step 1.4:

```bash
docker run --rm postgres:16 psql "$POLY_TRACKER_DATABASE_URL" -At -c "
  SELECT 'farms', count(*) FROM poly.farms UNION ALL
  SELECT 'paddocks', count(*) FROM poly.paddocks UNION ALL
  SELECT 'poly_runs', count(*) FROM poly.poly_runs UNION ALL
  SELECT 'features', count(*) FROM poly.features UNION ALL
  SELECT 'photos', count(*) FROM poly.photos UNION ALL
  SELECT 'farm_members', count(*) FROM poly.farm_members;"
```

### 1.2 Start a throwaway PostGIS

Never restore into Supabase to test. A local container, same major versions as CI:

```bash
docker run -d --name poly-restore -e POSTGRES_PASSWORD=restore -p 55432:5432 postgis/postgis:16-3.4
sleep 5
export RESTORE_URL='postgresql://postgres:restore@localhost:55432/postgres'
```

On Supabase PostGIS and pgcrypto live in the `extensions` schema and the dump refers to them that way, so
create them there first (the dump does not, because it is `poly` only):

```bash
docker exec -i poly-restore psql -U postgres -v ON_ERROR_STOP=1 <<'SQL'
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS postgis  WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
ALTER DATABASE postgres SET search_path = poly, extensions, public;
SQL
```

### 1.3 Restore

```bash
docker exec -i poly-restore psql -U postgres -v ON_ERROR_STOP=1 -d postgres < backups/poly_schema_<stamp>.sql
```

`ON_ERROR_STOP=1` matters: without it psql carries on past a failed `CREATE TABLE` and the "restore" ends with
missing tables and a zero exit code. If it stops on a missing role or extension, fix the target (step 1.2),
drop the container and start again; do not edit the dump.

### 1.4 Prove it

```bash
docker exec -i poly-restore psql -U postgres -At -c "
  SELECT 'farms', count(*) FROM poly.farms UNION ALL
  SELECT 'paddocks', count(*) FROM poly.paddocks UNION ALL
  SELECT 'poly_runs', count(*) FROM poly.poly_runs UNION ALL
  SELECT 'features', count(*) FROM poly.features UNION ALL
  SELECT 'photos', count(*) FROM poly.photos UNION ALL
  SELECT 'farm_members', count(*) FROM poly.farm_members;"
docker exec -i poly-restore psql -U postgres -At -c \
  "SELECT count(*) FROM poly.paddocks WHERE NOT extensions.ST_IsValid(geom);"
```

Pass = every count equals the live count from 1.1 and the invalid-geometry count is `0`. Then point a local API
at it as the last word (reads only):

```bash
cd api && DATABASE_URL="$RESTORE_URL" PHOTO_STORAGE_PATH=/tmp/poly-restore-photos npm run dev
curl -s localhost:3001/api/health        # → {"ok":true,"db":"up",…}
curl -s localhost:3001/api/farms | head  # → the farms from the dump
```

Photos: the dump holds the `photos` rows, not the bytes. The bytes are in the private Supabase Storage bucket
(`poly-photos`): back them up with 1.6 at the same time as the dump and drill them with 1.7. A photo row restored
without its object shows a broken image.

Clean up (after 1.7 if you are drilling photos too): `docker rm -f poly-restore`.

### 1.5 Restoring for real

Only after a drill has passed with the same dump. Restore into the empty `poly` schema with the **migration**
role (`POLY_TRACKER_MIGRATION_URL`, DDL-capable), not `poly_app`, and never with `--clean`: if `poly` still has
tables, rename the schema aside (`ALTER SCHEMA poly RENAME TO poly_broken_<date>;`), recreate `poly` from
`db/init`, then load only the data (`pg_restore`/`psql` of a `--data-only` dump). Re-run `GRANT`s from `db/init`.
Then put the photo bytes back with 1.7's script and `--bucket poly-photos --into-production` (it never overwrites
an object that is already there).

### 1.6 Back up the photo bytes (PT47)

Right after the dump in 1.1, same shell. The script lists the bucket and downloads every object to a dated folder.
It is **read-only against Storage** (it lists and reads; it never uploads, signs, moves or deletes), and it checks
the folder against the `photos` table: every row's object must be there. Same environment as the API:

```bash
cd api
export DATABASE_URL="$POLY_TRACKER_DATABASE_URL" PGSSL=true
export PHOTO_BACKEND=supabase SUPABASE_URL='https://<project-ref>.supabase.co'
read -rs SUPABASE_SERVICE_ROLE_KEY && export SUPABASE_SERVICE_ROLE_KEY   # paste it (from Vercel); not echoed
npx tsx scripts/backup-photos.ts --out ../backups/photos-$(date +%F)
```

It prints `N listed · N downloaded · N already here · 0 failed`, then the folder's file count and bytes, the
`photos` row count, `missing: 0` and `unclaimed (orphans): N`, and ends `✓ <folder>`. Exit `0` only when every
`photos` row has its bytes in the folder and the folder's count and bytes equal `manifest.json`; `1` otherwise.

- **Resumable.** Re-run with the same `--out` after a failure or a Ctrl+C: files already there at the size the
  bucket lists are kept, only the rest are fetched. Downloads land as `*.partial` and are renamed when complete.
- **`missing` must be 0.** A missing object is a row whose photo is already gone from the bucket, which no
  backup can fix; note the keys in the log.
- **`unclaimed`** objects are orphans (PT27). They are backed up anyway and are not a failure.
- `backups/` is gitignored. Copy the folder (with `manifest.json`) to the same place as the dump.

Self-hosted (disk storage): leave `PHOTO_BACKEND` unset and set `PHOTO_STORAGE_PATH` to the photo volume instead.

### 1.7 Restore drill for the photo bytes (PT47)

Never drill into `poly-photos`. Restore into a **throwaway bucket** in the same project, then delete it:

1. Supabase dashboard → Storage → **New bucket** → name `poly-photos-restore-<YYYY-MM-DD>`, **Private** → Create.
2. Restore. Each file's size and sha256 are checked against `manifest.json` first, and nothing is overwritten:

   ```bash
   cd api
   export SUPABASE_URL='https://<project-ref>.supabase.co'
   read -rs SUPABASE_SERVICE_ROLE_KEY && export SUPABASE_SERVICE_ROLE_KEY
   npx tsx scripts/restore-photos.ts --from ../backups/photos-<date> --bucket poly-photos-restore-<YYYY-MM-DD>
   ```

   Pass = `N restored · 0 already there (left as they were) · 0 corrupt in the backup · 0 failed · 0 not in the
   target afterwards` and `✓ every manifest object is in Supabase bucket …`, with N equal to the backup's object
   count. The script refuses `--bucket poly-photos` (or whatever `SUPABASE_PHOTO_BUCKET` names) unless
   `--into-production`.
3. Prove a restored photo opens: point a local API at the restored rows (1.4) **and** the throwaway bucket:

   ```bash
   DATABASE_URL="$RESTORE_URL" PHOTO_BACKEND=supabase SUPABASE_PHOTO_BUCKET=poly-photos-restore-<YYYY-MM-DD> npm run dev
   # second shell:
   id=$(docker exec -i poly-restore psql -U postgres -At -c "SELECT id FROM poly.photos LIMIT 1")
   curl -sL -o /tmp/photo -w '%{http_code} %{content_type}\n' "localhost:3001/api/photos/file/$id"   # → 200 image/…
   ```

4. Delete the throwaway bucket: Storage → `poly-photos-restore-<date>` → **Empty bucket**, then **Delete bucket**.

**Fully offline variant** (no Supabase at all): `--dir /tmp/poly-restore-photos` instead of `--bucket …` restores
into a folder. The restored rows hold bare object keys and the disk backend serves absolute paths, so rewrite them
in the **throwaway** database only, then serve with the disk backend:

```bash
npx tsx scripts/restore-photos.ts --from ../backups/photos-<date> --dir /tmp/poly-restore-photos
docker exec -i poly-restore psql -U postgres -c "UPDATE poly.photos SET path = '/tmp/poly-restore-photos/' || path"
DATABASE_URL="$RESTORE_URL" PHOTO_STORAGE_PATH=/tmp/poly-restore-photos npm run dev    # then the curl in step 3
```

### 1.8 The weekly `Backup` workflow (PT47)

`.github/workflows/backup.yml` runs 1.1 and 1.6 every Monday at 03:17 UTC (and on **Run workflow**), packs both
into **one encrypted file**, proves it decrypts and holds every photo object and the dump, and uploads it as a
workflow artifact kept **35 days**. A failure opens (or comments on) an issue titled `Backup failed`, label
`ops-alarm`.

**Why encrypted:** this repository is public, and a public repository's workflow artifacts can be downloaded by
any signed-in GitHub user. The artifact is `tar | gpg --symmetric --cipher-algo AES256`; nothing leaves the job in
plain text.

**Repository secrets** (GitHub → Settings → Secrets and variables → Actions → New repository secret). The job fails
at its first step, naming each one that is missing:

| Secret | Value |
|---|---|
| `POLY_TRACKER_DATABASE_URL` | the `poly_app` pooler DSN, exactly as in Vercel's `DATABASE_URL` (no `?sslmode=`) |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | the service role key (see the rotation table: shared by every app in the project) |
| `BACKUP_PASSPHRASE` | a new long random string (2.1 step 1). **Keep a copy outside GitHub** (password manager): GitHub cannot show it back, and without it every artifact is unreadable |

Rotate `POLY_TRACKER_DATABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` here too whenever section 2 rotates them in
Vercel. Changing `BACKUP_PASSPHRASE` leaves older artifacts readable only with the old one.

**Restore from an artifact:** Actions → Backup → a green run → Artifacts → `poly-backup-<stamp>` (a zip holding
`poly-backup-<stamp>.tar.gpg`). Then, in Git Bash (gpg ships with Git for Windows), from the repo root:

```bash
mkdir -p backups/restore && cd backups/restore
unzip ~/Downloads/poly-backup-<stamp>.zip
read -rs BACKUP_PASSPHRASE   # paste it; not echoed, not in shell history
gpg --batch --pinentry-mode loopback --passphrase-fd 3 --decrypt poly-backup-<stamp>.tar.gpg 3<<<"$BACKUP_PASSPHRASE" | tar -xf -
unset BACKUP_PASSPHRASE
ls   # poly_schema_<stamp>.sql  photos/
```

and drill from there: 1.2 to 1.4 with `backups/restore/poly_schema_<stamp>.sql`, 1.7 with
`--from ../backups/restore/photos`.

GitHub disables scheduled workflows in a public repository after **60 days without a commit**. If the Actions tab
shows that banner, re-enable the workflow there; the `Backup failed` issue cannot fire for a run that never starts.

---

## 2. Secret rotation

**Schedule:**

| Secret | Where it lives | Every | Also rotate when |
|---|---|---|---|
| `API_WRITE_TOKEN` | Vercel env; each device's Settings page (localStorage) | 90 days | a device is lost, someone leaves, it is seen in a screenshot/log/chat |
| `API_READ_TOKEN` (if set) | Vercel env; Settings page | 90 days | as above |
| `AUTH_SESSION_SECRET` (users mode) | Vercel env | 180 days | any suspicion; it signs every session cookie |
| `poly_app` DB password | Vercel `DATABASE_URL`; `backlog_bandit/.env` `POLY_TRACKER_DATABASE_URL`; GitHub secret `POLY_TRACKER_DATABASE_URL` (PT47) | 180 days | the DSN appears anywhere it should not |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel env; GitHub secret (PT47 backup) | on suspicion only | **shared by every app in the project**: rotating it breaks Our_Menu and Cortana until they are updated too; plan it across all three |
| `VITE_MAPBOX_TOKEN` | Vercel env (public by design) | not scheduled | keep its URL restriction set in the Mapbox dashboard |

### 2.1 API write / read token

1. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
2. Vercel → Poly Tracker project → Settings → Environment Variables → edit `API_WRITE_TOKEN` (Production and
   Preview) → save → Deployments → **Redeploy** the current production deployment (env changes apply only to
   new deployments).
3. On every device: open the app → **Settings** → paste the new token.
   Until a device is updated its writes answer **401**. The offline edit queue and the photo queue treat 401 as
   retryable, so nothing queued is lost: edits wait on the device and sync once the token is updated.
   A device still sending the OLD token trips the per-credential limit (10 failures per minute, PT43) and gets
   429 for that minute, but only for the old token: other devices on the same farm wifi are not affected, and
   the moment it has the new token it is through.
4. Check: `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://poly-tracker-ashy.vercel.app/api/farms -H 'Authorization: Bearer <old token>' -H 'Content-Type: application/json' -d '{}'` → `401`.
5. Update `backlog_bandit/.env` if the token is recorded there (the verify harnesses read it).

### 2.2 Session secret (users mode only)

Same as 2.1 steps 1, 2 and 5 for `AUTH_SESSION_SECRET` (32+ characters). Every session cookie becomes invalid
at once: everyone signs in again with a magic link. No data effect.

### 2.3 `poly_app` database password

1. Supabase dashboard → SQL editor (runs as `postgres`):
   ```sql
   ALTER ROLE poly_app WITH PASSWORD '<new password>';
   ```
   Generate the password the same way as 2.1 step 1. Do not reuse one from another app's role.
2. The running app keeps working on its open connections but **new** connections fail from this moment, so do
   steps 3 and 4 straight away (minutes, not hours).
3. Vercel → `DATABASE_URL` → same DSN with the new password (keep the pooler host, keep **no** `?sslmode=`, see
   DEPLOY.md) → save → Redeploy.
4. `backlog_bandit/.env` → `POLY_TRACKER_DATABASE_URL` → same change.
5. Check: `curl -s https://poly-tracker-ashy.vercel.app/api/health` → `"db":"up"` from the new deployment, and
   the old DSN refused:
   `docker run --rm postgres:16 psql '<old DSN>' -c 'select 1'` → `password authentication failed`.

---

## 3. After a deploy that changes headers (PT43)

The SPA's security headers come from `vercel.json`; the API's from `api/src/middleware/securityHeaders.ts`.
Neither can be exercised before Vercel serves them:

```bash
curl -sI https://poly-tracker-ashy.vercel.app/ | grep -iE 'content-security-policy|x-content-type|x-frame|referrer-policy|strict-transport'
curl -sI https://poly-tracker-ashy.vercel.app/api/health | grep -iE 'content-security-policy|x-content-type|x-frame'
```

Expect the SPA CSP on `/` and `default-src 'none'` on `/api/health`, never both on one response.

Self-hosted (`docker-compose.prod.yml`), the SPA headers come from `web/nginx.prod.conf` (PT48), kept equal to
`vercel.json` by `web/src/lib/nginxHeaders.test.ts`. Check a running stack with
`node scripts/check-nginx-headers.mjs http://localhost:8080` (CI runs the same check against the nginx image).

Two things the CSP assumes, which will bite when they change:

- **Supabase is reached at `https://*.supabase.co`.** The magic-link call (`connect-src`) and the signed photo
  URLs the API redirects to (`img-src`) are allowed by that wildcard only. If the project ever moves to a
  **custom Supabase domain**, add it to both directives in `vercel.json`, or sign-in and photos break with a CSP
  error and nothing else.
- **Preview deployments block the Vercel toolbar.** `vercel.json` applies the same headers to preview URLs,
  and the CSP allows neither `vercel.live` scripts nor framing, so the preview comments/feedback toolbar does
  not load (console: `Refused to load the script 'https://vercel.live/…'`). That is expected, not a bug in the
  app. If the toolbar is wanted, disable it in the Vercel project settings rather than widening the CSP. Then open the
map with devtools → Console and switch through all three basemaps, open a photo, export a PDF: any
`Refused to … because it violates the following Content Security Policy directive` line names the missing host.
Add it to `vercel.json` **and** let `web/src/lib/csp.test.ts` tell you if the code names it too.

---

## Log

### Backup / restore drills

| Date | Who | Dump file (size, tables, COPY blocks) | Restored counts match live? | Photos (objects, bytes, missing; restored into) | Notes |
|---|---|---|---|---|---|
| | | | | | never run yet |

### Rotations

| Date | Secret | Who | Devices updated | Notes |
|---|---|---|---|---|
| | | | | never run yet |
