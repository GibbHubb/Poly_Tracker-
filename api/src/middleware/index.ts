import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { ZodError } from 'zod';
import { log, routeShape } from './observability.js';

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

/**
 * PT35 — what the CALLER may see vs what the LOG gets.
 *
 * Our own errors (HttpError, ZodError, the 413) keep their bodies: they are
 * messages we wrote, and some are load-bearing UI text (PT23's 503, PT18's
 * 412). Anything else is an error we did not anticipate, and its `message` is
 * whatever the library put there — for `pg` that names tables, columns,
 * constraints and sometimes the host. That used to be returned verbatim, to an
 * unauthenticated GET. Now the log keeps all of it and the caller gets a
 * generic sentence plus the request id that finds it in the log.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(
  err: unknown,
  req: Request,
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
  const requestId = String(res.locals.requestId ?? '');
  // body-parser's own refusals carry a status; they used to fall through to a 500.
  const bodyErr = (err as { type?: unknown; status?: unknown } | null) ?? {};
  if (bodyErr.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Request body is not valid JSON.', requestId });
    return;
  }
  if (bodyErr.type === 'entity.too.large') {
    res.status(413).json({ error: 'Request body is too large.', requestId });
    return;
  }
  // Any other refusal that already carries a 4xx (unsupported encoding, aborted
  // request): keep its status, never its text.
  if (typeof bodyErr.status === 'number' && bodyErr.status >= 400 && bodyErr.status < 500) {
    res.status(bodyErr.status).json({ error: 'The request could not be read.', requestId });
    return;
  }
  const code = (err as { code?: unknown } | null)?.code;
  const pgCode = typeof code === 'string' ? code : undefined;
  res.locals.errorCode = pgCode;
  // Caller mistakes (mapped to 4xx below) are logged at warn; they are not our fault.
  const callerFault = pgCode === '22P02' || pgCode === '23503';
  log({
    level: callerFault ? 'warn' : 'error',
    msg: 'unhandled error',
    requestId,
    method: req.method,
    path: routeShape(req.originalUrl),
    code: pgCode,
    error: err instanceof Error ? err.message : String(err),
    stack: callerFault ? undefined : err instanceof Error ? err.stack : undefined,
  });
  // 22P02 = invalid_text_representation: a malformed id in the URL or body
  // (e.g. /api/farms/not-a-uuid). That is the caller's mistake, not ours.
  if (pgCode === '22P02') {
    res.status(400).json({ error: 'Malformed identifier or value.', requestId });
    return;
  }
  // 23503 = foreign_key_violation: the farm/feature this row points at does not
  // exist (deleted elsewhere, or a bad id). A 404, not a 500: a 5xx is "try again
  // later", and the offline queue would replay this one forever.
  if (pgCode === '23503') {
    res.status(404).json({
      error: 'The farm or record this refers to does not exist (it may have been deleted).',
      requestId,
    });
    return;
  }
  res.status(500).json({
    error: 'Something went wrong on the server. Quote the request id if you report it.',
    requestId,
  });
}
