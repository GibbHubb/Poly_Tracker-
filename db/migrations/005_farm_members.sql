-- PT33 — who may see and change which farm.
--
-- Before this, authorisation did not exist: `GET /api/farms` returned every farm
-- to anyone holding the shared read token, and the write token could PATCH or
-- DELETE any of them. With AUTH_USERS=on the API now resolves a person (a
-- Supabase `auth.users` id) and every farm-scoped route checks this table.
--
-- `auth.users` is shared with Our_Menu and Cortana, so an account existing is
-- NOT an entitlement: a user with no row here sees nothing.
--
-- Roles: owner (everything, incl. delete and managing members), editor (read +
-- write the farm's records), viewer (read only).
--
-- Additive and inert while AUTH_USERS is off. Contains NO data: the backfill
-- (every existing farm -> Max as owner) is api/scripts/backfill-farm-members.mjs,
-- which dry-runs by default and writes only with --apply (mass-write gate).
-- IF NOT EXISTS throughout, matching 001-004; apply-schema.mjs (PT30) records it.

CREATE TABLE IF NOT EXISTS farm_members (
    farm_id    uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
    user_id    uuid NOT NULL,
    role       text NOT NULL DEFAULT 'editor' CHECK (role IN ('owner', 'editor', 'viewer')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (farm_id, user_id)
);

-- "Which farms can this person see" is the hot query (GET /api/farms).
CREATE INDEX IF NOT EXISTS farm_members_user_idx ON farm_members (user_id);

-- On the Supabase project, tie membership to the identity provider so deleting
-- an account removes its memberships. Conditional: a self-hosted/docker database
-- has no auth schema, and the table must still work there.
DO $$
BEGIN
  IF to_regclass('auth.users') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'farm_members_user_fk') THEN
    ALTER TABLE farm_members
      ADD CONSTRAINT farm_members_user_fk
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;
