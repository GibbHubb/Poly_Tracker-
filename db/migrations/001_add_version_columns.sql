-- PT18-fu1 — optimistic concurrency for the three editable resources.
--
-- PT15's conflict machinery and PT18's field-level merge both only trigger when
-- a replayed write hits a 409/412, but every UPDATE was last-write-wins, so the
-- API never emitted one and the merge UI was unreachable without hand-seeding a
-- db.conflicts row.
--
-- A monotonic `version` is used rather than `updated_at`: timestamps collide
-- when two writes land inside the same clock tick and drag in clock-skew
-- questions, whereas an integer bumped by the UPDATE itself cannot.
--
-- Additive and idempotent (ADD COLUMN IF NOT EXISTS + a DEFAULT), so it is safe
-- to re-run and safe against a populated database — every existing row starts
-- at version 1.

ALTER TABLE farms    ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE paddocks ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE features ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
