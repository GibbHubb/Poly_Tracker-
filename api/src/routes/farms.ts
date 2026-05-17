import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { asyncHandler, HttpError } from '../middleware/index.js';

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
}

farmsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const { rows } = await query<FarmRow>(
      'SELECT id, name, owner, created_at FROM farms ORDER BY created_at DESC',
    );
    res.json(rows);
  }),
);

farmsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await query<FarmRow>(
      'SELECT id, name, owner, created_at FROM farms WHERE id = $1',
      [req.params.id],
    );
    if (rows.length === 0) throw new HttpError(404, 'Farm not found');
    res.json(rows[0]);
  }),
);

farmsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = farmInput.parse(req.body);
    const { rows } = await query<FarmRow>(
      'INSERT INTO farms (name, owner) VALUES ($1, $2) RETURNING id, name, owner, created_at',
      [body.name, body.owner ?? null],
    );
    res.status(201).json(rows[0]);
  }),
);

farmsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const body = farmInput.partial().parse(req.body);
    const { rows } = await query<FarmRow>(
      `UPDATE farms
         SET name = COALESCE($2, name),
             owner = COALESCE($3, owner)
       WHERE id = $1
       RETURNING id, name, owner, created_at`,
      [req.params.id, body.name ?? null, body.owner ?? null],
    );
    if (rows.length === 0) throw new HttpError(404, 'Farm not found');
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
