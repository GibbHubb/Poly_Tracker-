-- PT31 — an unindexed photo lookup and four unbounded whole-farm queries per
-- map open.
--
-- Two gaps, one additive fix:
--
-- 1. `photos` (db/init/02_schema.sql:48-56) has NO index at all, so
--    `GET /api/photos?feature_id=…` (fired on every feature-dialog open) and
--    the farm_id join (fired on every farm open) are both sequential scans.
-- 2. `paddocks_farm_idx` / `poly_runs_farm_idx` / `features_farm_idx` are
--    single-column, but every list query is `WHERE farm_id = $1 ORDER BY
--    created_at` — the sort is always a separate step. A composite index lets
--    the same index serve both the filter and the sort.
--
-- PT31's risk note: replacing the single-column farm_id indexes outright could
-- regress a query this ticket has not seen, so this migration only ADDS the
-- composite indexes; the single-column ones stay until pg_stat_user_indexes
-- shows zero scans on them (a follow-up, not part of this ticket).
--
-- CONCURRENTLY was considered (avoids a table lock) but rejected for this
-- migration: CREATE INDEX CONCURRENTLY cannot run inside a transaction, and
-- apply-schema.mjs (PT30) wraps every migration file in one BEGIN/COMMIT.
-- Splitting this file in two just to dodge the wrapper is not worth it because
-- the live `poly` tables are currently EMPTY (confirmed 2026-09-24) — a plain
-- CREATE INDEX on an empty table takes a lock for microseconds. If this ever
-- needs to run against a populated table, apply it by hand with CONCURRENTLY
-- outside the runner instead of through this file.
--
-- IF NOT EXISTS on every index: idempotent and safe to re-run, matching 001/002.

CREATE INDEX IF NOT EXISTS photos_feature_id_idx ON photos (feature_id);
CREATE INDEX IF NOT EXISTS photos_taken_at_idx   ON photos (taken_at);

CREATE INDEX IF NOT EXISTS paddocks_farm_created_idx  ON paddocks  (farm_id, created_at);
CREATE INDEX IF NOT EXISTS poly_runs_farm_created_idx ON poly_runs (farm_id, created_at);
CREATE INDEX IF NOT EXISTS features_farm_created_idx  ON features  (farm_id, created_at);
