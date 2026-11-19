// PT33 — sign-in / sign-out. Mounted BEFORE the gate: these are how you get
// through it.
//
// The SPA does the magic link against Supabase Auth itself (implicit flow, so
// the link opens on whichever device the email is read on), then hands the
// access token to POST /api/auth/session once. We verify it and swap it for
// our own 30-day HttpOnly cookie. Why a cookie of our own rather than keeping
// the Supabase token in the browser:
//   - an <img src="/api/photos/file/:id"> cannot send a header, but it does
//     send a same-origin cookie, so photos display with reads locked;
//   - HttpOnly keeps it away from any script on the page (the localStorage
//     token was readable by any XSS);
//   - a field tool goes weeks offline; a Supabase access token dies in 7 days
//     and its refresh needs the network. 30 days from the last sign-in is the
//     honest "sign in once per device".
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError } from '../middleware/index.js';
import { identify } from '../middleware/authorize.js';
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  sessionConfigured,
  signSession,
  usersModeOn,
  verifySupabaseJwt,
} from '../lib/identity.js';

export const authRouter = Router();

function secureCookie(req: Request): boolean {
  return process.env.NODE_ENV === 'production' || req.secure || req.get('x-forwarded-proto') === 'https';
}

function setSessionCookie(req: Request, res: Response, value: string, maxAgeSeconds: number): void {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    'Path=/api',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secureCookie(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

/** What the SPA needs to know to offer sign-in. All of it is public by design. */
authRouter.get('/config', (_req, res) => {
  const on = usersModeOn();
  res.json({
    users_mode: on,
    supabase_url: on ? process.env.SUPABASE_URL ?? null : null,
    supabase_publishable_key: on ? process.env.SUPABASE_PUBLISHABLE_KEY ?? null : null,
  });
});

const sessionInput = z.object({ access_token: z.string().min(1) });

authRouter.post(
  '/session',
  asyncHandler(async (req, res) => {
    if (!usersModeOn()) throw new HttpError(404, 'Per-user sign-in is not enabled on this deployment.');
    if (!sessionConfigured()) {
      throw new HttpError(503, 'Sign-in is not configured on this deployment.');
    }
    const { access_token } = sessionInput.parse(req.body);
    const id = await verifySupabaseJwt(access_token);
    if (!id) throw new HttpError(401, 'That sign-in link is invalid or has expired. Request a new one.');
    setSessionCookie(req, res, signSession(id), SESSION_TTL_SECONDS);
    res.status(201).json({ user_id: id.userId, email: id.email });
  }),
);

authRouter.delete('/session', (req, res) => {
  setSessionCookie(req, res, '', 0);
  res.status(204).end();
});

authRouter.get(
  '/me',
  asyncHandler(async (req, res) => {
    if (!usersModeOn()) {
      res.json({ users_mode: false });
      return;
    }
    const id = await identify(req);
    if (!id) {
      res.status(401).json({ users_mode: true, error: 'Not signed in.' });
      return;
    }
    if (id.kind === 'user') res.json({ users_mode: true, kind: 'user', user_id: id.userId, email: id.email });
    else res.json({ users_mode: true, kind: id.kind });
  }),
);
