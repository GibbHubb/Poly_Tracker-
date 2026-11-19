// PT33 — who belongs to a farm. Mounted at /api/farms/:farmId/members, behind
// requireFarmMember (so a non-member already got a 404 before reaching here).
// Listing needs read; adding/removing needs owner.
//
// People are added by their user id (shown to them on the Settings page): the
// app role cannot read auth.users, and an email lookup would be an enumeration
// oracle over every Our_Menu/Cortana account. Follow-up material, not v1.
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { asyncHandler, HttpError } from '../middleware/index.js';
import { assertFarmAccess, identityOf } from '../middleware/authorize.js';
import { usersModeOn } from '../lib/identity.js';

export const membersRouter = Router({ mergeParams: true });

membersRouter.use((_req, _res, next) => {
  next(usersModeOn() ? undefined : new HttpError(404, 'Not found'));
});

interface MemberRow {
  user_id: string;
  role: string;
  created_at: string;
}

membersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const farmId = (req.params as { farmId: string }).farmId;
    const { rows } = await query<MemberRow>(
      'SELECT user_id, role, created_at FROM farm_members WHERE farm_id = $1 ORDER BY created_at',
      [farmId],
    );
    res.json(rows);
  }),
);

const addInput = z.object({
  user_id: z.string().uuid(),
  role: z.enum(['owner', 'editor', 'viewer']).default('editor'),
});

membersRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const farmId = (req.params as { farmId: string }).farmId;
    await assertFarmAccess(res, farmId, 'owner');
    const body = addInput.parse(req.body);
    const { rows } = await query<MemberRow>(
      `INSERT INTO farm_members (farm_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (farm_id, user_id) DO UPDATE SET role = EXCLUDED.role
       RETURNING user_id, role, created_at`,
      [farmId, body.user_id, body.role],
    );
    res.status(201).json(rows[0]);
  }),
);

membersRouter.delete(
  '/:userId',
  asyncHandler(async (req, res) => {
    const { farmId, userId } = req.params as { farmId: string; userId: string };
    const me = identityOf(res);
    // Leaving a farm yourself is always allowed; removing someone else is the owner's call.
    if (!(me.kind === 'user' && me.userId === userId)) await assertFarmAccess(res, farmId, 'owner');
    // Never leave a farm with nobody able to manage it. (Two owners removing
    // each other at the same instant could still both pass under READ
    // COMMITTED; acceptable for a handful of people per farm.)
    const { rowCount } = await query(
      `DELETE FROM farm_members m
        WHERE m.farm_id = $1 AND m.user_id = $2
          AND (m.role <> 'owner'
               OR EXISTS (SELECT 1 FROM farm_members o
                           WHERE o.farm_id = $1 AND o.role = 'owner' AND o.user_id <> $2))`,
      [farmId, userId],
    );
    if (rowCount === 0) {
      const { rows } = await query('SELECT 1 FROM farm_members WHERE farm_id = $1 AND user_id = $2', [farmId, userId]);
      if (rows.length > 0) throw new HttpError(409, 'A farm must keep at least one owner.');
      throw new HttpError(404, 'Member not found');
    }
    res.status(204).end();
  }),
);
