import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { ZodError } from 'zod';

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** Constant-time compare with a length guard (no early-length leak). */
function safeEqual(provided: string, secret: string): boolean {
  try {
    if (provided.length !== secret.length) return false;
    return timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
  } catch {
    return false;
  }
}

/** Extract a `Bearer <token>` value from the Authorization header (or ''). */
function bearerToken(req: Request): string {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

/**
 * Bearer-token gate with read/write tiers.
 *   writeToken = API_WRITE_TOKEN ?? API_TOKEN (legacy)
 *   readToken  = API_READ_TOKEN
 * - Mutations (POST/PATCH/PUT/DELETE) require the write token. In production
 *   an unconfigured write token DISABLES writes (PT23); outside production it
 *   leaves them open, which is what local dev and the test suite rely on.
 * - Safe methods (GET/HEAD/OPTIONS) require the read token only when one is set;
 *   a valid write token also satisfies a read check (write ⊇ read). Reads stay
 *   open by default on purpose — the public map is meant to be readable.
 * - No-op (open mode) when neither secret is configured, dev only.
 * Legacy single-`API_TOKEN` deployments are a strict subset: it maps to write,
 * no read token is set, so reads stay open exactly as before.
 *
 * PT23 — why production fails closed rather than open.
 *
 * The gate was wired in from the start and switched off by simply not setting
 * the env var, so a live deployment served unauthenticated CRUD on every farm,
 * paddock and pipe run to anyone who found the URL, and nothing anywhere said
 * so: an unset secret read exactly like a working service. Forgetting a
 * dashboard field must not be the difference between "locked" and "world
 * writable". Now the same omission produces a loud 503 on the first write
 * instead, which fails in the direction that cannot lose data.
 *
 * Deliberately NOT gated on NODE_ENV alone being absent: `node dist/index.js`
 * with no NODE_ENV is how someone runs this locally against a scratch DB, and
 * that should stay frictionless. Render sets NODE_ENV=production.
 */
export const requireToken: RequestHandler = (req, res, next) => {
  const writeToken = process.env.API_WRITE_TOKEN || process.env.API_TOKEN || '';
  const readToken = process.env.API_READ_TOKEN || '';
  const isProd = process.env.NODE_ENV === 'production';
  const isMutation = MUTATING_METHODS.has(req.method);

  // PT23 — in production a mutation without a configured write token is a
  // misconfiguration, not an invitation. 503 (not 401) so the message reads as
  // "this server is not set up" rather than "your token is wrong".
  if (isProd && isMutation && !writeToken) {
    res.status(503).json({
      error:
        'Writes are disabled: API_WRITE_TOKEN is not configured on this deployment.',
    });
    return;
  }

  // Open mode: nothing configured (dev/test only — production mutations were
  // already turned away above).
  if (!writeToken && !readToken) {
    next();
    return;
  }

  const provided = bearerToken(req);

  if (isMutation) {
    // Writes stay open when no write token is set (only a read token exists).
    if (!writeToken || safeEqual(provided, writeToken)) {
      next();
      return;
    }
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // Safe method: gated only when a read token is configured.
  if (!readToken) {
    next();
    return;
  }
  if (safeEqual(provided, readToken) || (writeToken && safeEqual(provided, writeToken))) {
    next();
    return;
  }
  res.status(401).json({ error: 'Unauthorized' });
};

/** Wrap an async route handler so thrown errors reach the error middleware. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'ValidationError', issues: err.issues });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  // PT26 — multer's size refusal used to fall through to a 500.
  if ((err as { code?: string } | null)?.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({
      error: 'Photo is too large to upload (the limit is 4 MB). The app shrinks photos before sending; update the app if you see this.',
    });
    return;
  }
  const message = err instanceof Error ? err.message : 'Internal Server Error';
  console.error('[api] unhandled error:', err);
  res.status(500).json({ error: message });
}
