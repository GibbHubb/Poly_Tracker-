-- PT30 — poly_runs joins the optimistic-concurrency scheme.
--
-- 001_add_version_columns.sql (PT18-fu1) added `version` to farms, paddocks and
-- features, and stopped there. Poly runs are the entity the product is NAMED
-- after, and they were the one editable object with no precondition: their
-- PATCH is a bare `UPDATE ... WHERE id = $1 AND farm_id = $2`, so a pipe run's
-- diameter, depth, material and route could be silently overwritten by a stale
-- tab or a replayed offline edit, with nothing anywhere reporting it.
--
-- The reason it stayed missing for so long is not that nobody noticed — three
-- separate files carry a comment about it (FeatureSidebar.tsx:22-27 spells it
-- out). It is that `apply-schema.mjs` could not run against the live database
-- at all after PT22 moved the schema into `poly`, so no migration written after
-- that point could reach production. That is fixed in the same commit as this.
--
-- Idempotent, and must stay so: the ledger this ticket adds starts empty, so
-- this file is applied once by the ledger but may be re-run by hand on a
-- database that already has the column.
ALTER TABLE poly_runs ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

-- Every pre-existing row reads 1 rather than NULL, so the first If-Match a
-- client sends has something to match against. NOT NULL DEFAULT 1 above already
-- backfills, but assert it rather than assume: a column added NOT NULL DEFAULT
-- on a large table is exactly where a surprise would hide.
DO $$
DECLARE bad integer;
BEGIN
  SELECT count(*) INTO bad FROM poly_runs WHERE version IS NULL OR version < 1;
  IF bad > 0 THEN
    RAISE EXCEPTION 'PT30: % poly_runs row(s) have no usable version', bad;
  END IF;
END $$;
