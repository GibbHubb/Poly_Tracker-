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
 * - Mutations (POST/PATCH/PUT/DELETE) require the write token — but stay OPEN
 *   when no write token is configured (symmetric with open mode).
 * - Safe methods (GET/HEAD/OPTIONS) require the read token only when one is set;
 *   a valid write token also satisfies a read check (write ⊇ read).
 * - No-op (open mode) when neither secret is configured.
 * Legacy single-`API_TOKEN` deployments are a strict subset: it maps to write,
 * no read token is set, so reads stay open exactly as before.
 */
export const requireToken: RequestHandler = (req, res, next) => {
  const writeToken = process.env.API_WRITE_TOKEN || process.env.API_TOKEN || '';
  const readToken = process.env.API_READ_TOKEN || '';

  // Open mode: nothing configured.
  if (!writeToken && !readToken) {
    next();
    return;
  }

  const provided = bearerToken(req);

  if (MUTATING_METHODS.has(req.method)) {
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
  const message = err instanceof Error ? err.message : 'Internal Server Error';
  console.error('[api] unhandled error:', err);
  res.status(500).json({ error: message });
}
