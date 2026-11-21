// PT43 — rate limiting: the token gate and writes.
//
// In-memory, fixed window, keyed by client IP. On Vercel that memory is ONE
// function instance's: each warm instance counts separately and a cold start
// forgets everything, so the real ceiling is "limit × instances". That is still
// what it is for — a single client brute-forcing the bearer token, or a runaway
// loop replaying writes — and it costs nothing. A fleet-wide limit needs a
// shared store (Upstash/Redis), which is deliberately not taken on here.
//
// Three limits:
//   one bad credential — after AUTH_FAILURES_MAX 401s for the SAME credential
//                    from one IP inside the window, requests carrying THAT
//                    credential get 429 until the window ends. Keyed on IP + a
//                    hash of the credential (the credential is never stored),
//                    so one device with a stale or rotated token behind shared
//                    farm wifi / CGNAT does not lock out the other devices there;
//   many bad credentials — after AUTH_DISTINCT_MAX distinct failing credentials
//                    from one IP inside the window (a brute force: every guess
//                    is new), requests from that IP with a credential that has
//                    not succeeded from it recently get 429. Devices that were
//                    already working keep working;
//   writes         — more than WRITES_MAX mutations per IP per window → 429.
// Requests with no credential are never limited by the first two (nothing is
// being guessed). /api/health is never limited (the operator's probe), and
// /api/auth/* is never limited by the credential counters: that is the
// sign-in that fixes a stale cookie. It still counts toward the write limit.
//
// 429 is safe for the web client: the offline edit queue and the photo queue
// both treat it as retryable (web/src/lib/notify.ts RETRYABLE_4XX,
// photoQueue.ts TRANSIENT_4XX), so a throttled replay waits and tries again,
// it is never dropped.
import type { NextFunction, Request, Response } from 'express';
import { createHash } from 'node:crypto';
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
 * nginx, which sets X-Real-IP; failing that, the right-most X-Forwarded-For
 * hop). Otherwise the socket address, so a direct
 * caller cannot pick its own key by sending a header.
 */
export function clientIp(req: Request): string {
  const trust = Boolean(process.env.VERCEL) || process.env.TRUST_PROXY === '1';
  if (trust) {
    const real = req.get('x-real-ip');
    if (real) return real.trim();
    // The RIGHT-most hop is the one our proxy appended; everything to its
    // left came from the client and can say anything.
    const fwd = req.get('x-forwarded-for');
    if (fwd) {
      const hops = fwd.split(',').map((h) => h.trim()).filter(Boolean);
      if (hops.length) return hops[hops.length - 1]!;
    }
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

export interface RateLimitOptions {
  windowMs: number;
  /** 401s for one credential from one IP inside a window before that credential is refused. */
  authFailuresMax: number;
  /** Distinct failing credentials from one IP inside a window before unproven credentials from it are refused. */
  authDistinctMax: number;
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
    authDistinctMax: intEnv('RATE_LIMIT_AUTH_DISTINCT', 20),
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

/**
 * A short, one-way fingerprint of whatever credential the request offered
 * (bearer header and/or cookie), or null when it offered none. Only this hash
 * is kept, never the credential.
 */
export function credentialKey(req: Request): string | null {
  const auth = req.headers.authorization ?? '';
  const cookie = req.headers.cookie ?? '';
  if (!auth && !cookie) return null;
  return createHash('sha256').update(`${auth}\n${cookie}`).digest('hex').slice(0, 32);
}

/** How long a credential that worked from an IP stays exempt from the many-credentials limit. */
const PROVEN_WINDOWS = 15;

/** Build the limiter middleware. `null` options → a pass-through. */
export function createRateLimiter(opts: RateLimitOptions | null) {
  if (!opts) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }
  const now = opts.now ?? Date.now;
  const failures = new FixedWindowCounter(opts.windowMs, now); // ip|credential → 401s
  const distinct = new FixedWindowCounter(opts.windowMs, now); // ip → distinct failing credentials
  const proven = new FixedWindowCounter(opts.windowMs * PROVEN_WINDOWS, now); // ip|credential → successes
  const writes = new FixedWindowCounter(opts.windowMs, now); // ip → mutations

  return function rateLimit(req: Request, res: Response, next: NextFunction): void {
    const path = req.originalUrl.split('?')[0] ?? '';
    if (path === '/api/health') {
      next();
      return;
    }
    const ip = clientIp(req);
    const cred = credentialKey(req);
    const authRoute = path.startsWith('/api/auth/');
    const key = cred ? `${ip}|${cred}` : null;
    if (key && !authRoute) {
      const failed = failures.peek(key);
      if (failed.count >= opts.authFailuresMax) {
        refuse(req, res, failed.resetAt, now(), 'auth_failures', ip);
        return;
      }
      const spread = distinct.peek(ip);
      if (spread.count >= opts.authDistinctMax && proven.peek(key).count === 0) {
        refuse(req, res, spread.resetAt, now(), 'auth_distinct_credentials', ip);
        return;
      }
    }
    if (MUTATING_METHODS.has(req.method)) {
      const w = writes.hit(ip);
      if (w.count > opts.writesMax) {
        refuse(req, res, w.resetAt, now(), 'writes', ip);
        return;
      }
    }
    // Only requests that offered a credential are counted: a signed-out
    // browser gets a 401 on every call it makes without one, and nothing is
    // being guessed. The 429s above are not counted: being throttled must not
    // extend the throttle.
    if (key && !authRoute) {
      res.on('finish', () => {
        if (res.statusCode === 401) {
          if (failures.hit(key).count === 1) distinct.hit(ip);
        } else if (res.statusCode < 400) {
          proven.hit(key);
        }
      });
    }
    next();
  };
}
