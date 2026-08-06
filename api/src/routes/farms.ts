import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { asyncHandler, HttpError } from '../middleware/index.js';
import { parseIfMatch, setVersionETag, throwUpdateConflict } from '../lib/concurrency.js';

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
    const { rows } = await query<FarmRow>(
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
    const { rows } = await query<FarmRow>(
      'INSERT INTO farms (name, owner) VALUES ($1, $2) RETURNING id, name, owner, created_at, version',
      [body.name, body.owner ?? null],
    );
    setVersionETag(res, rows[0]!.version);
    res.status(201).json(rows[0]);
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
    const { rowCount } = await query('DELETE FROM farms WHERE id = $1', [
      req.params.id,
    ]);
    if (rowCount === 0) throw new HttpError(404, 'Farm not found');
    res.status(204).end();
  }),
);
