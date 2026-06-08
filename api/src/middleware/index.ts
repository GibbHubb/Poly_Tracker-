import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { ZodError } from 'zod';

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** Bearer-token write gate. No-op when API_TOKEN is unset (open mode). */
export const requireToken: RequestHandler = (req, res, next) => {
  const token = process.env.API_TOKEN;
  if (!token || !MUTATING_METHODS.has(req.method)) {
    next();
    return;
  }
  const header = req.headers.authorization ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  let authorized = false;
  try {
    if (provided.length === token.length) {
      authorized = timingSafeEqual(Buffer.from(provided), Buffer.from(token));
    }
  } catch {
    authorized = false;
  }
  if (!authorized) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
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
