// PT43 — security headers on every API response.
//
// No `helmet`: four fixed headers do not need a dependency. The API only ever
// answers JSON, a 204, a 302 to a signed storage URL, or (self-hosted disk
// backend) a photo file, so its policy can be deny-all: nothing it returns is
// a document that should load scripts, styles or frames. The SPA's own, wider
// CSP is set by vercel.json on every non-/api path, so the two never stack on
// one response.
import type { NextFunction, Request, Response } from 'express';

export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Content-Security-Policy', API_CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
}
