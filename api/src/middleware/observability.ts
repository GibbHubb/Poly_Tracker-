// PT35 — request ids, one access-log line per request, and a small in-memory
// record of recent failures that an operator can curl.
//
// Why this exists: a 500 used to leave exactly one trace, a `console.error`
// with no way to tie it to the request (or the user) that caused it. Now every
// response carries `x-request-id`, the same id is on the server's log line, and
// a 500 body names it, so "it broke" from a user becomes one grep in the logs.
//
// No logging dependency on purpose: one JSON line per request is enough for six
// routes and costs nothing at cold start on a serverless function.

import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

/** An inbound id is reused only if it looks like an id, never arbitrary text in our logs. */
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.header('x-request-id');
  const id = inbound && SAFE_ID.test(inbound) ? inbound : randomUUID();
  res.locals.requestId = id;
  res.setHeader('x-request-id', id);
  next();
}

/** Path without its query string, with uuids folded so the ring cannot list record ids. */
export function routeShape(originalUrl: string): string {
  const path = originalUrl.split('?')[0] ?? originalUrl;
  return path.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    ':id',
  );
}

export interface LogLine {
  level: 'info' | 'warn' | 'error';
  msg: string;
  requestId?: string;
  method?: string;
  path?: string;
  status?: number;
  ms?: number;
  [k: string]: unknown;
}

/** One JSON object per line: greppable on Vercel, parseable by anything. */
export function log(line: LogLine): void {
  const out = JSON.stringify({ t: new Date().toISOString(), ...line });
  if (line.level === 'error') console.error(out);
  else if (line.level === 'warn') console.warn(out);
  else console.log(out);
}

// ---------------------------------------------------------------------------
// Recent-failure ring. Per INSTANCE and lost on a cold start: on serverless
// this is one function instance's memory, not the fleet's. /api/health says so
// by reporting the instance id and uptime beside it, so a quiet ring can never
// be read as "nothing is failing anywhere" (the PT22 lesson).
// ---------------------------------------------------------------------------

export interface RecentError {
  t: string;
  requestId: string;
  method: string;
  path: string;
  status: number;
  /** pg SQLSTATE or similar machine code. Never the message: /api/health is public. */
  code?: string;
}

const RING_SIZE = 20;
const ring: RecentError[] = [];
const counters = { requests: 0, serverErrors: 0, clientErrors: 0 };
const instanceId = randomUUID().slice(0, 8);
const startedAt = Date.now();

export function recordError(e: RecentError): void {
  ring.unshift(e);
  if (ring.length > RING_SIZE) ring.length = RING_SIZE;
}

export function healthStats() {
  return {
    instance: instanceId,
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    scope: 'this function instance only, since its start',
    requests: counters.requests,
    errors_5xx: counters.serverErrors,
    errors_4xx: counters.clientErrors,
    recent_errors: ring.slice(),
  };
}

/** Test hook: start each case from a clean ring. */
export function resetHealthStats(): void {
  ring.length = 0;
  counters.requests = 0;
  counters.serverErrors = 0;
  counters.clientErrors = 0;
}

export function accessLog(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const status = res.statusCode;
    counters.requests += 1;
    if (status >= 500) counters.serverErrors += 1;
    else if (status >= 400) counters.clientErrors += 1;
    const path = routeShape(req.originalUrl);
    const requestId = String(res.locals.requestId ?? '');
    if (status >= 500) {
      recordError({
        t: new Date().toISOString(),
        requestId,
        method: req.method,
        path,
        status,
        code: res.locals.errorCode as string | undefined,
      });
    }
    log({
      level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
      msg: 'request',
      requestId,
      method: req.method,
      path,
      status,
      ms: Math.round(ms * 10) / 10,
    });
  });
  next();
}
