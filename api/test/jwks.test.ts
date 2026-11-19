/**
 * PT33 review — the JWKS fetch behind ES256 sign-in, with `fetch` mocked (no network):
 *   - it gives up after JWKS_FETCH_TIMEOUT_MS (AbortSignal.timeout) instead of hanging;
 *   - at most one fetch per refetch-floor window, even with NO cache yet (Supabase down);
 *   - a token with an unknown `kid` cannot force more than one fetch per window;
 *   - callers that arrive together share one fetch.
 * And the issuer is required: no SUPABASE_URL, no accepted token.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  JWKS_FETCH_TIMEOUT_MS,
  JWKS_REFETCH_FLOOR_MS,
  assertAuthConfig,
  resetJwksCache,
  verifySupabaseJwt,
} from '../src/lib/identity.js';

const SUPABASE_URL = 'https://example-ref.supabase.co';
const KID = 'kid-1';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const JWKS = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'ES256', use: 'sig' }] };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

function jwt(kid = KID, iss = `${SUPABASE_URL}/auth/v1`): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'ES256', typ: 'JWT', kid });
  const body = b64({ sub: randomUUID(), aud: 'authenticated', role: 'authenticated', iss, iat: now, exp: now + 3600 });
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${sig.toString('base64url')}`;
}

const ok = () => new Response(JSON.stringify(JWKS), { status: 200, headers: { 'Content-Type': 'application/json' } });
const down = () => new Response('{}', { status: 503 });

let fetchMock: ReturnType<typeof vi.fn>;
let clock = 1_000_000_000_000;

beforeEach(() => {
  resetJwksCache();
  vi.stubEnv('SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('SUPABASE_JWKS', '');
  vi.stubEnv('SUPABASE_JWT_SECRET', '');
  fetchMock = vi.fn(async () => ok());
  vi.stubGlobal('fetch', fetchMock);
  clock = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('JWKS fetch (PT33 review)', () => {
  it('verifies a good token with one fetch, and caches it', async () => {
    expect(await verifySupabaseJwt(jwt())).not.toBeNull();
    expect(await verifySupabaseJwt(jwt())).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('passes an abort signal and gives up after the timeout instead of hanging', async () => {
    // A Supabase that accepts the connection and never answers: only the signal ends it.
    fetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    );
    vi.mocked(Date.now).mockRestore(); // real time for this one
    const t0 = performance.now();
    expect(await verifySupabaseJwt(jwt())).toBeNull();
    const ms = performance.now() - t0;
    expect(fetchMock.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
    expect(ms).toBeGreaterThanOrEqual(JWKS_FETCH_TIMEOUT_MS - 50);
    expect(ms).toBeLessThan(JWKS_FETCH_TIMEOUT_MS + 2_000);
  }, 15_000);

  it('with Supabase down and no cache, fetches at most once per floor window', async () => {
    fetchMock.mockImplementation(async () => down());
    for (let i = 0; i < 5; i++) expect(await verifySupabaseJwt(jwt())).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1); // was 5: with no cache there was no floor, so every token fetched

    clock += JWKS_REFETCH_FLOOR_MS + 1;
    fetchMock.mockImplementation(async () => ok());
    expect(await verifySupabaseJwt(jwt())).not.toBeNull(); // recovers after the window
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a stream of unknown-kid tokens forces at most one refetch per window', async () => {
    expect(await verifySupabaseJwt(jwt())).not.toBeNull(); // warm cache: 1 fetch
    clock += JWKS_REFETCH_FLOOR_MS + 1;
    for (let i = 0; i < 5; i++) expect(await verifySupabaseJwt(jwt(`rogue-${i}`))).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2); // one forced refetch, then floored
    clock += 1_000;
    for (let i = 0; i < 5; i++) expect(await verifySupabaseJwt(jwt(`rogue-b-${i}`))).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('callers that arrive together at a cold start share one fetch', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fetchMock.mockImplementation(async () => {
      await gate;
      return ok();
    });
    const pending = Array.from({ length: 5 }, () => verifySupabaseJwt(jwt()));
    release();
    const out = await Promise.all(pending);
    expect(out.every((r) => r !== null)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('issuer is required (PT33 review)', () => {
  it('no SUPABASE_URL: a correctly signed token is refused', async () => {
    vi.stubEnv('SUPABASE_JWKS', JSON.stringify(JWKS));
    expect(await verifySupabaseJwt(jwt())).not.toBeNull();
    vi.stubEnv('SUPABASE_URL', '');
    expect(await verifySupabaseJwt(jwt())).toBeNull();
  });

  it('users mode without SUPABASE_URL fails the startup check; token mode does not care', () => {
    vi.stubEnv('SUPABASE_URL', '');
    vi.stubEnv('AUTH_USERS', 'on');
    expect(() => assertAuthConfig()).toThrow(/AUTH_USERS=on requires SUPABASE_URL/);
    vi.stubEnv('SUPABASE_URL', SUPABASE_URL);
    expect(() => assertAuthConfig()).not.toThrow();
    vi.stubEnv('AUTH_USERS', '');
    vi.stubEnv('SUPABASE_URL', '');
    expect(() => assertAuthConfig()).not.toThrow();
  });

  it('loading the app (what Vercel and `node dist/index.js` do) fails in users mode without SUPABASE_URL', () => {
    const load = (env: Record<string, string>) =>
      spawnSync(process.execPath, [fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)), '-e', "import('./src/index.ts')"], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, SUPABASE_URL: '', AUTH_USERS: '', ...env },
        encoding: 'utf8',
        timeout: 60_000,
      });
    const bad = load({ AUTH_USERS: 'on' });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/AUTH_USERS=on requires SUPABASE_URL/);
    expect(load({ AUTH_USERS: 'on', SUPABASE_URL }).status).toBe(0);
    expect(load({}).status).toBe(0);
  }, 120_000);
});
