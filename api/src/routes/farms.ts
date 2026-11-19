import { Router } from 'express';
import { z } from 'zod';
import { pool, query } from '../db.js';
import { asyncHandler, HttpError } from '../middleware/index.js';
import { parseIfMatch, setVersionETag, throwUpdateConflict } from '../lib/concurrency.js';
import { assertFarmAccess, identityOf } from '../middleware/authorize.js';
import { farmCreatorVerdict } from '../lib/identity.js';
import { log } from '../middleware/observability.js';

export const farmsRouter = Router();

const farmInput = z.object({
  name: z.string().min(1),
  owner: z.string().min(1).nullish(),
});

interface FarmRow {
  id: string;
  name: string;
  owner: string | null;
  created_at: string;
  version: number;
}

farmsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const id = identityOf(res);
    // PT33 — a signed-in person sees the farms they are a member of, filtered
    // in SQL (not in the UI). Open mode / legacy token: every farm, as before.
    const { rows } =
      id.kind === 'user'
        ? await query<FarmRow>(
            `SELECT f.id, f.name, f.owner, f.created_at, f.version
               FROM farms f JOIN farm_members m ON m.farm_id = f.id
              WHERE m.user_id = $1
              ORDER BY f.created_at DESC`,
            [id.userId],
          )
        : await query<FarmRow>(
            'SELECT id, name, owner, created_at, version FROM farms ORDER BY created_at DESC',
          );
    res.json(rows);
  }),
);

farmsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await query<FarmRow>(
      'SELECT id, name, owner, created_at, version FROM farms WHERE id = $1',
      [req.params.id],
    );
    if (rows.length === 0) throw new HttpError(404, 'Farm not found');
    setVersionETag(res, rows[0]!.version);
    res.json(rows[0]);
  }),
);

farmsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = farmInput.parse(req.body);
    const id = identityOf(res);
    const insertFarm =
      'INSERT INTO farms (name, owner) VALUES ($1, $2) RETURNING id, name, owner, created_at, version';
    let farm: FarmRow;
    if (id.kind === 'user') {
      // PT33 review — signing in is open to every user of the shared Supabase project, so
      // creating a farm is not: AUTH_FARM_CREATORS lists who may. Unset → nobody (fail
      // closed). The env var name is for the operator's log, not the caller (PT41).
      const verdict = farmCreatorVerdict(id);
      if (verdict !== 'allowed') {
        log({
          level: 'warn',
          msg:
            verdict === 'unset'
              ? 'farm create refused: AUTH_FARM_CREATORS is unset (users mode fails closed)'
              : 'farm create refused: caller is not in AUTH_FARM_CREATORS',
          requestId: String(res.locals.requestId ?? ''),
          userId: id.userId,
        });
        throw new HttpError(
          403,
          verdict === 'unset'
            ? 'Creating farms is switched off on this deployment. Ask the operator to allow your account.'
            : 'Your account is not allowed to create farms. Ask the operator to allow it, or ask a farm owner to add you.',
        );
      }
      // PT33 — the creator owns it. One transaction: a farm with no owner
      // would be invisible to the very person who just made it.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query<FarmRow>(insertFarm, [body.name, body.owner ?? null]);
        farm = rows[0]!;
        await client.query(
          "INSERT INTO farm_members (farm_id, user_id, role) VALUES ($1, $2, 'owner')",
          [farm.id, id.userId],
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    } else {
      const { rows } = await query<FarmRow>(insertFarm, [body.name, body.owner ?? null]);
      farm = rows[0]!;
    }
    setVersionETag(res, farm.version);
    res.status(201).json(farm);
  }),
);

farmsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const body = farmInput.partial().parse(req.body);
    // PT18-fu1 — when If-Match is absent `expected` is null and the version
    // predicate is a no-op, preserving last-write-wins for existing clients.
    const expected = parseIfMatch(req);
    const { rows } = await query<FarmRow>(
      `UPDATE farms
         SET name = COALESCE($2, name),
             owner = COALESCE($3, owner),
             version = version + 1
       WHERE id = $1
         AND ($4::int IS NULL OR version = $4)
       RETURNING id, name, owner, created_at, version`,
      [req.params.id, body.name ?? null, body.owner ?? null, expected],
    );
    if (rows.length === 0) {
      if (expected !== null) {
        await throwUpdateConflict('farms', req.params.id, expected, 'Farm not found');
      }
      throw new HttpError(404, 'Farm not found');
    }
    setVersionETag(res, rows[0]!.version);
    res.json(rows[0]);
  }),
);

farmsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    // PT33 — deleting cascades to every paddock, run, feature and photo row,
    // so it is the owner's call, not an editor's. (Read/write membership was
    // already checked for /api/farms/:farmId in index.ts.)
    await assertFarmAccess(res, String(req.params.id), 'owner');
    const { rowCount } = await query('DELETE FROM farms WHERE id = $1', [
      req.params.id,
    ]);
    if (rowCount === 0) throw new HttpError(404, 'Farm not found');
    res.status(204).end();
  }),
);
