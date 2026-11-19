// PT33 — who is calling.
//
// Two credentials identify a PERSON (a Supabase `auth.users` id):
//   1. the `pt_session` cookie this API sets at sign-in (HMAC-signed, 30 days),
//      which is what lets an <img> tag load a photo with reads locked;
//   2. a Supabase access token sent as `Authorization: Bearer <jwt>`.
//
// Verification facts, measured 2026-11-17 against the shared project
// (qzgrukdwukkcghacolua) via the Management API: the signing key IN USE is
// ES256 (asymmetric, published at /auth/v1/.well-known/jwks.json); the old
// HS256 secret is "previously_used". So JWKS is the primary path, and HS256
// (SUPABASE_JWT_SECRET) is honoured only if an operator sets it, for tokens
// issued before the rotation. Access tokens live 7 days (jwt_exp = 604800).
//
// No JWT library: node:crypto verifies ES256/RS256 from a JWK and HS256 from a
// secret, which is all three algorithms Supabase can issue.
import { createHmac, createPublicKey, timingSafeEqual, verify, type KeyObject } from 'node:crypto';

export const SESSION_COOKIE = 'pt_session';
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface UserIdentity {
  userId: string;
  email: string | null;
}

/** Users-mode is OFF unless explicitly switched on; off = the pre-PT33 token gate. */
export function usersModeOn(): boolean {
  return process.env.AUTH_USERS === 'on';
}

/**
 * PT33 review — users mode cannot check a token's issuer without SUPABASE_URL, and an
 * unchecked issuer would accept a token minted by ANY Supabase project whose key we were
 * handed. Called at module load (src/index.ts), so a misconfigured deploy fails to start
 * (on Vercel: the function errors) instead of running with the check silently off.
 */
export function assertAuthConfig(): void {
  if (usersModeOn() && !process.env.SUPABASE_URL) {
    throw new Error('AUTH_USERS=on requires SUPABASE_URL (the issuer every access token is checked against).');
  }
}

/**
 * PT33 review — who may create a farm in users mode. Any valid user of the SHARED Supabase
 * project (Our_Menu and Cortana accounts too) can sign in, so creation is an allowlist:
 * AUTH_FARM_CREATORS, a comma list of auth user ids and/or emails (case-insensitive).
 * Unset or empty → nobody: fail closed. Ids are the stronger form; an email only matches
 * the `email` claim Supabase put in the token.
 */
export function farmCreatorVerdict(id: UserIdentity): 'allowed' | 'denied' | 'unset' {
  const list = (process.env.AUTH_FARM_CREATORS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0) return 'unset';
  const mine = [id.userId.toLowerCase(), ...(id.email ? [id.email.trim().toLowerCase()] : [])];
  return mine.some((v) => list.includes(v)) ? 'allowed' : 'denied';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

function b64urlJson(s: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(b64urlDecode(s).toString('utf8'));
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function safeEqualBuf(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── JWKS ────────────────────────────────────────────────────────────────────

interface Jwk {
  kid?: string;
  kty: string;
  alg?: string;
  [k: string]: unknown;
}

type KeyMap = Map<string, { key: KeyObject; alg: string }>;
let jwksCache: { keys: KeyMap; at: number } | null = null;
let lastFetchAttempt = 0;
let inflight: Promise<KeyMap> | null = null;
const JWKS_TTL_MS = 10 * 60 * 1000;
export const JWKS_REFETCH_FLOOR_MS = 30 * 1000;
export const JWKS_FETCH_TIMEOUT_MS = 5_000;

function buildKeyMap(jwks: { keys?: Jwk[] }): Map<string, { key: KeyObject; alg: string }> {
  const map = new Map<string, { key: KeyObject; alg: string }>();
  for (const jwk of jwks.keys ?? []) {
    if (!jwk.kid) continue;
    try {
      const key = createPublicKey({ key: jwk as unknown as import('node:crypto').JsonWebKey, format: 'jwk' });
      map.set(jwk.kid, { key, alg: jwk.alg ?? (jwk.kty === 'EC' ? 'ES256' : 'RS256') });
    } catch {
      // A key we cannot parse is skipped, not fatal: the others may still verify.
    }
  }
  return map;
}

/**
 * Test/offline hook: SUPABASE_JWKS holds the JWKS JSON inline; otherwise fetch it.
 *
 * PT33 review — at most ONE fetch per JWKS_REFETCH_FLOOR_MS, whatever the callers do:
 * the floor holds with no cache yet (a dead or slow Supabase is not hit once per
 * request) and for a forced refetch (a token with an unknown `kid` is caller input; a
 * stream of them must not become a stream of fetches). Callers that arrive while a fetch
 * is running share it. The fetch gives up after JWKS_FETCH_TIMEOUT_MS, so a hung
 * Supabase fails sign-in in 5 s instead of holding every request open.
 */
async function loadJwks(force: boolean): Promise<KeyMap> {
  const inline = process.env.SUPABASE_JWKS;
  if (inline) return buildKeyMap(JSON.parse(inline) as { keys?: Jwk[] });
  const now = Date.now();
  if (jwksCache && !force && now - jwksCache.at < JWKS_TTL_MS) return jwksCache.keys;
  if (inflight) return inflight;
  if (now - lastFetchAttempt < JWKS_REFETCH_FLOOR_MS) return jwksCache?.keys ?? new Map();
  const base = process.env.SUPABASE_URL;
  if (!base) return new Map();
  lastFetchAttempt = now;
  inflight = (async () => {
    const res = await fetch(`${base.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`, {
      signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
    const keys = buildKeyMap((await res.json()) as { keys?: Jwk[] });
    jwksCache = { keys, at: now };
    return keys;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** For tests: forget the cached JWKS. */
export function resetJwksCache(): void {
  jwksCache = null;
  lastFetchAttempt = 0;
  inflight = null;
}

// ── Supabase access token ───────────────────────────────────────────────────

export function looksLikeJwt(token: string): boolean {
  return token.split('.').length === 3;
}

/**
 * Verify a Supabase access token. Returns the identity, or null for ANY
 * failure (bad signature, unknown key, expired, wrong audience/issuer, not a
 * signed-in user). Never throws on caller input.
 */
export async function verifySupabaseJwt(token: string): Promise<UserIdentity | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  const header = b64urlJson(h);
  const payload = b64urlJson(p);
  if (!header || !payload) return null;
  const signingInput = Buffer.from(`${h}.${p}`);
  const sig = b64urlDecode(s);
  const alg = header.alg;

  let ok = false;
  try {
    if (alg === 'HS256') {
      const secret = process.env.SUPABASE_JWT_SECRET;
      if (!secret) return null;
      const expected = createHmac('sha256', secret).update(signingInput).digest();
      ok = safeEqualBuf(expected, sig);
    } else if (alg === 'ES256' || alg === 'RS256') {
      const kid = typeof header.kid === 'string' ? header.kid : '';
      let keys = await loadJwks(false);
      if (!keys.has(kid)) keys = await loadJwks(true); // key rotation
      const entry = keys.get(kid);
      if (!entry || entry.alg !== alg) return null;
      ok = verify(
        'sha256',
        signingInput,
        alg === 'ES256' ? { key: entry.key, dsaEncoding: 'ieee-p1363' } : entry.key,
        sig,
      );
    } else {
      return null; // "none" and anything else
    }
  } catch {
    return null;
  }
  if (!ok) return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
  if (typeof payload.nbf === 'number' && payload.nbf > now + 30) return null;
  const aud = payload.aud;
  const audOk = aud === 'authenticated' || (Array.isArray(aud) && aud.includes('authenticated'));
  if (!audOk) return null;
  if (payload.role !== 'authenticated') return null;
  // PT33 review — the issuer is ALWAYS checked: no SUPABASE_URL, no accepted token (users
  // mode refuses to start without it; see assertAuthConfig).
  const base = process.env.SUPABASE_URL;
  if (!base || payload.iss !== `${base.replace(/\/$/, '')}/auth/v1`) return null;
  if (!isUuid(payload.sub)) return null;
  return { userId: payload.sub, email: typeof payload.email === 'string' ? payload.email : null };
}

// ── Session cookie ──────────────────────────────────────────────────────────

function sessionSecret(): string | null {
  const s = process.env.AUTH_SESSION_SECRET;
  return s && s.length >= 32 ? s : null;
}

export function sessionConfigured(): boolean {
  return sessionSecret() !== null;
}

/** Sign a session for this identity. Throws when AUTH_SESSION_SECRET is unset/short. */
export function signSession(id: UserIdentity, ttlSeconds = SESSION_TTL_SECONDS): string {
  const secret = sessionSecret();
  if (!secret) throw new Error('AUTH_SESSION_SECRET is not configured (min 32 chars)');
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(
    JSON.stringify({ sub: id.userId, email: id.email, iat: now, exp: now + ttlSeconds }),
  ).toString('base64url');
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifySession(value: string): UserIdentity | null {
  const secret = sessionSecret();
  if (!secret) return null;
  const dot = value.indexOf('.');
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  const mac = b64urlDecode(value.slice(dot + 1));
  const expected = createHmac('sha256', secret).update(body).digest();
  if (!safeEqualBuf(expected, mac)) return null;
  const payload = b64urlJson(body);
  if (!payload) return null;
  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  if (!isUuid(payload.sub)) return null;
  return { userId: payload.sub, email: typeof payload.email === 'string' ? payload.email : null };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (!k || k in out) continue;
    try {
      out[k] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[k] = part.slice(eq + 1).trim();
    }
  }
  return out;
}
