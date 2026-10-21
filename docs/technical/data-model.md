# Data model

Source of truth: [`db/init/02_schema.sql`](../../db/init/02_schema.sql) (a fresh install) plus
[`db/migrations/`](../../db/migrations/) (what a running database has had applied). The two are kept
in step: every migration is also folded into `02_schema.sql`, so a fresh install matches a migrated
one. Checked line by line against both on 2026-10-21 (PT37).

**Conventions**

- Every geometry is **SRID 4326** (WGS 84 longitude/latitude). The API sends and receives GeoJSON;
  PostGIS converts with `ST_GeomFromGeoJSON` / `ST_AsGeoJSON`.
- Primary keys are `uuid` defaulting to `gen_random_uuid()` (pgcrypto / Postgres 13+).
- Production lives in the `poly` schema of the shared Supabase project; the app role `poly_app`
  reaches it through its `search_path` (`poly, extensions`), which is why the SQL uses unqualified
  table names. See [`DEPLOY.md`](../../DEPLOY.md).

## Entities

### `farms`

| Field | Type | Notes |
|-------|------|-------|
| `id` | uuid PK | default `gen_random_uuid()` |
| `name` | text NOT NULL | |
| `owner` | text | free text, not a user reference (there are no user accounts yet, PT33) |
| `created_at` | timestamptz NOT NULL | default `now()` |
| `version` | integer NOT NULL | default 1; optimistic concurrency (PT18-fu1) |

### `paddocks`

| Field | Type | Notes |
|-------|------|-------|
| `id` | uuid PK | |
| `farm_id` | uuid NOT NULL | → `farms.id`, ON DELETE CASCADE |
| `name` | text NOT NULL | |
| `geom` | geometry(Polygon, 4326) | API refuses rings that are not closed, have < 3 corners, enclose no area or cross themselves (PT41, PT42) |
| `color` | text | |
| `notes` | text | |
| `created_at` | timestamptz NOT NULL | default `now()` |
| `version` | integer NOT NULL | default 1 |

`area_m2` in API responses is **derived** (`ST_Area(geom::geography)`), never stored; an incoming
`area_m2` property is stripped.

### `poly_runs`

| Field | Type | Notes |
|-------|------|-------|
| `id` | uuid PK | |
| `farm_id` | uuid NOT NULL | → `farms.id`, ON DELETE CASCADE |
| `name` | text NOT NULL | |
| `geom` | geometry(LineString, 4326) | API requires 2 different points |
| `diameter_mm` | int | positive |
| `depth_m` | numeric | positive |
| `material` | text | |
| `installed_date` | date | |
| `color` | text | |
| `notes` | text | |
| `created_at` | timestamptz NOT NULL | default `now()` |
| `version` | integer NOT NULL | default 1 (added by PT30, migration 002) |

### `features` (points)

| Field | Type | Notes |
|-------|------|-------|
| `id` | uuid PK | |
| `farm_id` | uuid NOT NULL | → `farms.id`, ON DELETE CASCADE |
| `type` | text NOT NULL | CHECK in `trough`, `turkey_nest`, `bore`, `gate`, `tank`, `tap`, `other` |
| `name` | text | |
| `geom` | geometry(Point, 4326) | lng −180..180, lat −90..90 |
| `color` | text | |
| `notes` | text | |
| `created_at` | timestamptz NOT NULL | default `now()` |
| `version` | integer NOT NULL | default 1 |

### `photos`

| Field | Type | Notes |
|-------|------|-------|
| `id` | uuid PK | |
| `feature_type` | text | the kind of thing photographed, as the client sends it |
| `feature_id` | uuid | **no foreign key**: a photo can outlive its feature |
| `path` | text NOT NULL | what the ACTIVE photo store returned: an absolute file path (`disk`) or an object key (`supabase`) |
| `taken_at` | timestamptz | from EXIF or the upload time |
| `lat` | numeric | from EXIF or the device fix; nullable |
| `lng` | numeric | |
| `client_id` | uuid | the uploader's id for this photo, the same on every retry (PT38, migration 004); unique |

No `version` column: photos are created and deleted, never edited.

## Indexes

| Index | Table | Columns | Why |
|-------|-------|---------|-----|
| `paddocks_geom_gist` | paddocks | GIST (`geom`) | spatial queries, `?bbox=` |
| `poly_runs_geom_gist` | poly_runs | GIST (`geom`) | 〃 |
| `features_geom_gist` | features | GIST (`geom`) | 〃 |
| `paddocks_farm_idx` | paddocks | `farm_id` | kept until shown unused (PT31) |
| `poly_runs_farm_idx` | poly_runs | `farm_id` | 〃 |
| `features_farm_idx` | features | `farm_id` | 〃 |
| `paddocks_farm_created_idx` | paddocks | (`farm_id`, `created_at`) | list queries filter AND sort (PT31, migration 003) |
| `poly_runs_farm_created_idx` | poly_runs | (`farm_id`, `created_at`) | 〃 |
| `features_farm_created_idx` | features | (`farm_id`, `created_at`) | 〃 |
| `photos_feature_id_idx` | photos | `feature_id` | the feature dialog's photo list (migration 003) |
| `photos_taken_at_idx` | photos | `taken_at` | photo lists sort by it (migration 003) |
| `photos_client_id_key` | photos | UNIQUE (`client_id`) | a retried upload is the same photo (migration 004) |

## Relationships

```
farms 1──N paddocks      (ON DELETE CASCADE)
farms 1──N poly_runs     (ON DELETE CASCADE)
farms 1──N features      (ON DELETE CASCADE)
features 1──N photos     (by photos.feature_id, NOT a foreign key)
```

Photos reach a farm only through `features`: `GET /api/photos?farm_id=` joins `photos.feature_id`
to `features.id`. Deleting a farm cascades its features but **not** their photos, which become
unreachable rows (and stored objects) until removed by hand; `api/scripts/sweep-photos.ts` (PT27)
reclaims stored objects that no row claims, not rows that no feature claims.

## Invariants

- Every geometry is SRID 4326 and of its table's single type (Polygon / LineString / Point).
- A paddock encloses an area and does not cross itself; a poly run has two different points; a
  point is a valid position. Enforced by the API's Zod schemas (`api/src/lib/geojson.ts`) and
  mirrored in the draw tool (`web/src/lib/geometryCheck.ts`), both tested against
  `fixtures/geometry-cases.json`. The database does not enforce validity.
- `version` only goes up: every UPDATE sets `version = version + 1`. A client that sends
  `If-Match: "<n>"` gets 412 if the row has moved on.
- `features.type` is one of the seven values in its CHECK constraint.
- A `photos.client_id` appears at most once.

## Migrations

- `db/init/01_extensions.sql` + `02_schema.sql` build a fresh database (docker-compose runs them
  on first volume init only).
- `db/migrations/NNN_*.sql` are the deltas for a database that already exists, applied in name
  order by `api/scripts/apply-schema.mjs` (`npm run db:init` in `api/`). It records each file in a
  `schema_migrations` ledger and runs it once, in its own transaction (PT30).
- Migrations run as a DDL-capable role (`POLY_TRACKER_MIGRATION_URL`), never as `poly_app`, which
  deliberately cannot create or drop tables.
- Every migration is written idempotent (`IF NOT EXISTS`) and additive, and the same change is
  folded into `02_schema.sql` in the same commit.

| File | Change |
|------|--------|
| `001_add_version_columns.sql` | `version` on farms, paddocks, features, poly_runs |
| `002_add_poly_runs_version.sql` | asserts every poly_runs row has a usable `version` (PT30) |
| `003_photo_and_composite_indexes.sql` | photo indexes + the three composite farm indexes (PT31) |
| `004_photo_client_id.sql` | `photos.client_id` + its unique index (PT38) |
