// PT43 — rate limiting: the token gate and writes.
//
// In-memory, fixed window, keyed by client IP. On Vercel that memory is ONE
// function instance's: each warm instance counts separately and a cold start
// forgets everything, so the real ceiling is "limit × instances". That is still
// what it is for — a single client brute-forcing the bearer token, or a runaway
// loop replaying writes — and it costs nothing. A fleet-wide limit needs a
// shared store (Upstash/Redis), which is deliberately not taken on here.
//
// Two limits:
//   auth failures  — after AUTH_FAILURES_MAX 401s from one IP inside the window,
//                    every request from that IP gets 429 until the window ends;
//   writes         — more than WRITES_MAX mutations per IP per window → 429.
// /api/health is never limited (it is the operator's probe).
//
// 429 is safe for the web client: the offline edit queue and the photo queue
// both treat it as retryable (web/src/lib/notify.ts RETRYABLE_4XX,
// photoQueue.ts TRANSIENT_4XX), so a throttled replay waits and tries again,
// it is never dropped.
import type { NextFunction, Request, Response } from 'express';
import { log, routeShape } from './observability.js';

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** One fixed-window counter per key. Expired windows are swept as the map grows. */
export class FixedWindowCounter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Add one hit for `key`; returns the count inside the current window and when it ends. */
  hit(key: string): { count: number; resetAt: number } {
    const t = this.now();
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      if (this.hits.size > 10_000) this.sweep(t);
      entry = { count: 0, resetAt: t + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    return { count: entry.count, resetAt: entry.resetAt };
  }

  /** The current count for `key` without adding a hit (0 once its window has ended). */
  peek(key: string): { count: number; resetAt: number } {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= this.now()) return { count: 0, resetAt: 0 };
    return { count: entry.count, resetAt: entry.resetAt };
  }

  private sweep(t: number): void {
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}

/**
 * The caller's IP. On Vercel the platform overwrites `x-real-ip` /
 * `x-forwarded-for` with the real client address, so they can be trusted
 * there; elsewhere they are only trusted when TRUST_PROXY=1 (self-hosted behind
 * nginx, which sets X-Real-IP). Otherwise the socket address, so a direct
 * caller cannot pick its own key by sending a header.
 */
export function clientIp(req: Request): string {
  const trust = Boolean(process.env.VERCEL) || process.env.TRUST_PROXY === '1';
  if (trust) {
    const real = req.get('x-real-ip');
    if (real) return real.trim();
    const fwd = req.get('x-forwarded-for');
    if (fwd) return fwd.split(',')[0]!.trim();
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

export interface RateLimitOptions {
  windowMs: number;
  /** 401s from one IP inside a window before that IP is refused. */
  authFailuresMax: number;
  /** Mutations from one IP inside a window. */
  writesMax: number;
  now?: () => number;
}

function intEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Limits from the environment, or null when limiting is off.
 * RATE_LIMIT=off disables it; RATE_LIMIT=on forces it on. Unset: on, except
 * under Vitest — the DB-backed suites send hundreds of writes and deliberate
 * 401s from 127.0.0.1, and the limiter has its own tests (rateLimit.test.ts).
 */
export function rateLimitFromEnv(): RateLimitOptions | null {
  const mode = process.env.RATE_LIMIT;
  if (mode === 'off') return null;
  if (mode !== 'on' && process.env.VITEST) return null;
  return {
    windowMs: intEnv('RATE_LIMIT_WINDOW_SECONDS', 60) * 1000,
    authFailuresMax: intEnv('RATE_LIMIT_AUTH_FAILURES', 10),
    writesMax: intEnv('RATE_LIMIT_WRITES', 120),
  };
}

function refuse(req: Request, res: Response, resetAt: number, now: number, reason: string, ip: string): void {
  const retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000));
  res.setHeader('Retry-After', String(retryAfter));
  log({
    level: 'warn',
    msg: 'security',
    event: 'rate.limited',
    reason,
    requestId: String(res.locals.requestId ?? ''),
    method: req.method,
    path: routeShape(req.originalUrl),
    ip,
  });
  res.status(429).json({
    error: 'Too many requests. Wait a minute and try again.',
    requestId: res.locals.requestId,
  });
}

/** Build the limiter middleware. `null` options → a pass-through. */
export function createRateLimiter(opts: RateLimitOptions | null) {
  if (!opts) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }
  const now = opts.now ?? Date.now;
  const failures = new FixedWindowCounter(opts.windowMs, now);
  const writes = new FixedWindowCounter(opts.windowMs, now);

  return function rateLimit(req: Request, res: Response, next: NextFunction): void {
    if (req.originalUrl.split('?')[0] === '/api/health') {
      next();
      return;
    }
    const ip = clientIp(req);
    const failed = failures.peek(ip);
    if (failed.count >= opts.authFailuresMax) {
      refuse(req, res, failed.resetAt, now(), 'auth_failures', ip);
      return;
    }
    if (MUTATING_METHODS.has(req.method)) {
      const w = writes.hit(ip);
      if (w.count > opts.writesMax) {
        refuse(req, res, w.resetAt, now(), 'writes', ip);
        return;
      }
    }
    // Count this request's 401, if it ends as one AND it presented a
    // credential: a guess always carries one, while a signed-out browser in
    // users mode gets a 401 on every call it makes without one, and must not
    // be locked out of the very sign-in it is about to do. /api/auth/me is a
    // "am I signed in?" probe, not a credential check. The 429s above are not
    // counted: being throttled must not extend the throttle.
    const presented = Boolean(req.headers.authorization || req.headers.cookie);
    const probe = req.originalUrl.split('?')[0] === '/api/auth/me';
    res.on('finish', () => {
      if (res.statusCode === 401 && presented && !probe) failures.hit(ip);
    });
    next();
  };
}
