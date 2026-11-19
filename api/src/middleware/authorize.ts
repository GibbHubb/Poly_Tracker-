// PT33 — authorisation: who may see and change which farm.
//
// With AUTH_USERS unset (the default, and production until Max switches it on)
// `resolveIdentity` IS the pre-PT33 `requireToken` gate and every access check
// below is a no-op, so behaviour is byte-for-byte what it was.
//
// With AUTH_USERS=on:
//   cookie session  → a person          (checked against farm_members per request)
//   Supabase JWT    → a person          (Authorization: Bearer <jwt>)
//   legacy token    → "legacy", all farms, write tier per token (kept for ONE
//                     release so nothing goes dark mid-migration)
//   nothing         → 401
// Revoking a person is deleting their farm_members row: membership is read on
// every request, so no shared secret has to change.
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { query } from '../db.js';
import {
  SESSION_COOKIE,
  looksLikeJwt,
  parseCookies,
  usersModeOn,
  verifySession,
  verifySupabaseJwt,
} from '../lib/identity.js';
import { asyncHandler, HttpError, requireToken } from './index.js';

export type Identity =
  | { kind: 'user'; userId: string; email: string | null; via: 'cookie' | 'bearer' }
  | { kind: 'legacy'; canWrite: boolean }
  | { kind: 'open' };

export type Role = 'owner' | 'editor' | 'viewer';
export type Need = 'read' | 'write' | 'owner';

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

function safeEqual(provided: string, secret: string): boolean {
  if (!provided || !secret || provided.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
}

function bearer(req: Request): string {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

export function identityOf(res: Response): Identity {
  return (res.locals.identity as Identity | undefined) ?? { kind: 'open' };
}

/** Origins allowed to make credentialed cross-origin calls (CORS_ORIGINS, comma-separated). */
export function allowedOrigins(): string[] {
  return (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

/**
 * CSRF guard for cookie-authenticated writes. SameSite=Lax already keeps the
 * cookie off cross-site POSTs; this also refuses a write whose Origin is a
 * different host that is not on the allowlist (e.g. a sibling subdomain).
 */
function originAllowed(req: Request): boolean {
  const origin = req.get('origin');
  if (!origin) return true; // same-origin navigations / non-browser clients
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  if (host === req.get('x-forwarded-host') || host === req.get('host')) return true;
  return allowedOrigins().includes(origin.replace(/\/$/, ''));
}

/** Work out who is calling (users mode) and attach it to res.locals.identity. */
export async function identify(req: Request): Promise<Identity | null> {
  const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (cookie) {
    const id = verifySession(cookie);
    if (id) return { kind: 'user', ...id, via: 'cookie' };
  }
  const token = bearer(req);
  if (token) {
    const writeToken = process.env.API_WRITE_TOKEN || process.env.API_TOKEN || '';
    const readToken = process.env.API_READ_TOKEN || '';
    if (safeEqual(token, writeToken)) return { kind: 'legacy', canWrite: true };
    if (safeEqual(token, readToken)) return { kind: 'legacy', canWrite: false };
    if (looksLikeJwt(token)) {
      const id = await verifySupabaseJwt(token);
      if (id) return { kind: 'user', ...id, via: 'bearer' };
    }
  }
  return null;
}

/**
 * The gate. Users mode off → exactly `requireToken`. Users mode on → an
 * identity is required for every route mounted after it.
 */
export const resolveIdentity: RequestHandler = (req, res, next) => {
  if (!usersModeOn()) {
    res.locals.identity = { kind: 'open' } satisfies Identity;
    requireToken(req, res, next);
    return;
  }
  identify(req)
    .then((id) => {
      if (!id) {
        res.status(401).json({ error: 'Sign in to use this app.' });
        return;
      }
      const isMutation = MUTATING_METHODS.has(req.method);
      if (id.kind === 'legacy' && isMutation && !id.canWrite) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      if (id.kind === 'user' && id.via === 'cookie' && isMutation && !originAllowed(req)) {
        res.status(403).json({ error: 'Cross-origin write refused.' });
        return;
      }
      res.locals.identity = id;
      next();
    })
    .catch(next);
};

const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };
const NEED_RANK: Record<Need, number> = { read: 1, write: 2, owner: 3 };

/**
 * Throw unless the caller may do `need` on this farm. No membership (or no such
 * farm) is a 404, never a 403: whether someone else's farm exists is itself
 * not the caller's business. Membership without enough role is a 403.
 */
export async function assertFarmAccess(res: Response, farmId: string, need: Need): Promise<void> {
  const id = identityOf(res);
  if (id.kind !== 'user') return; // open mode / legacy token: pre-PT33 behaviour
  const { rows } = await query<{ role: Role }>(
    'SELECT role FROM farm_members WHERE farm_id = $1 AND user_id = $2',
    [farmId, id.userId],
  );
  const role = rows[0]?.role;
  if (!role) throw new HttpError(404, 'Farm not found');
  if (RANK[role] < NEED_RANK[need]) {
    throw new HttpError(403, need === 'owner' ? 'Only a farm owner can do that.' : 'You have read-only access to this farm.');
  }
}

/** The farm a feature belongs to, or null. */
export async function farmOfFeature(featureId: string): Promise<string | null> {
  const { rows } = await query<{ farm_id: string }>('SELECT farm_id FROM features WHERE id = $1', [featureId]);
  return rows[0]?.farm_id ?? null;
}

/** The farm a photo belongs to (through its feature), or null. */
export async function farmOfPhoto(photoId: string): Promise<string | null> {
  const { rows } = await query<{ farm_id: string }>(
    'SELECT f.farm_id FROM photos p JOIN features f ON f.id = p.feature_id WHERE p.id = $1',
    [photoId],
  );
  return rows[0]?.farm_id ?? null;
}

/**
 * Mounted at /api/farms/:farmId — covers the farm itself and every nested
 * router (paddocks, poly-runs, features, members). GET needs read, anything
 * else needs write; DELETE of the farm itself additionally needs owner (farms.ts).
 */
export const requireFarmMember: RequestHandler = asyncHandler(
  async (req: Request, res: Response, next: NextFunction) => {
    const farmId = String(req.params.farmId ?? '');
    // PT33 review — leaving a farm (DELETE .../members/<your own id>) needs only membership,
    // so a viewer can leave; members.ts lets anyone remove themselves (last-owner rule aside).
    const id = identityOf(res);
    const leaving =
      req.method === 'DELETE' && id.kind === 'user' && req.path.replace(/\/$/, '') === `/members/${id.userId}`;
    const need: Need = leaving ? 'read' : MUTATING_METHODS.has(req.method) ? 'write' : 'read';
    if (farmId) await assertFarmAccess(res, farmId, need);
    next();
  },
);
