/**
 * PT33 — users mode: a person sees and changes only the farms they are a
 * member of. The negative cases (A cannot see or touch B) are the point; an
 * admin-shaped pass proves nothing.
 *
 * Tokens are real ES256 JWTs signed with a key generated here and published to
 * the API through SUPABASE_JWKS, i.e. the same verification path the live
 * project (ES256, JWKS) takes, minus the network fetch.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { createHmac, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { app } from '../src/index.js';
import { resetJwksCache } from '../src/lib/identity.js';
import { truncateAll, closePool } from './helpers.js';

const SUPABASE_URL = 'https://example-ref.supabase.co';
const KID = 'test-kid-1';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const JWKS = JSON.stringify({
  keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'ES256', use: 'sig' }],
});
// A second key the API does NOT trust.
const rogue = generateKeyPairSync('ec', { namedCurve: 'P-256' });

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

function jwt(
  sub: string,
  opts: { expIn?: number; key?: typeof privateKey; aud?: string; iss?: string; role?: string } = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'ES256', typ: 'JWT', kid: KID });
  const body = b64({
    sub,
    email: `${sub.slice(0, 4)}@example.test`,
    aud: opts.aud ?? 'authenticated',
    role: opts.role ?? 'authenticated',
    iss: opts.iss ?? `${SUPABASE_URL}/auth/v1`,
    iat: now,
    exp: now + (opts.expIn ?? 3600),
  });
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), {
    key: opts.key ?? privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${head}.${body}.${sig.toString('base64url')}`;
}

const USER_A = randomUUID();
const USER_B = randomUUID();
const USER_C = randomUUID(); // exists in auth.users, member of nothing
const A = `Bearer ${jwt(USER_A)}`;
const B = `Bearer ${jwt(USER_B)}`;
const C = `Bearer ${jwt(USER_C)}`;

const POLYGON = {
  type: 'Polygon',
  coordinates: [[[152.0, -27.0], [152.01, -27.0], [152.01, -27.01], [152.0, -27.01], [152.0, -27.0]]],
};
const POINT = { type: 'Point', coordinates: [152.0, -27.0] };
const JPEG = Buffer.from(
  'ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc00b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffda00080101000003f0007fffd9',
  'hex',
);

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params);
  return rows[0]!.n;
}

function usersOn() {
  vi.stubEnv('AUTH_USERS', 'on');
  vi.stubEnv('SUPABASE_URL', SUPABASE_URL);
  vi.stubEnv('SUPABASE_JWKS', JWKS);
  vi.stubEnv('SUPABASE_JWT_SECRET', '');
  vi.stubEnv('AUTH_SESSION_SECRET', 'x'.repeat(48));
  vi.stubEnv('API_WRITE_TOKEN', 'legacy-write-token');
  vi.stubEnv('API_TOKEN', '');
  vi.stubEnv('API_READ_TOKEN', '');
  vi.stubEnv('CORS_ORIGINS', '');
  vi.stubEnv('NODE_ENV', 'test');
  // PT33 review — farm creation in users mode is an allowlist; A and B may create, C may not.
  vi.stubEnv('AUTH_FARM_CREATORS', `${USER_A}, ${USER_B}`);
}

async function makeFarm(auth: string, name: string): Promise<string> {
  const res = await request(app).post('/api/farms').set('Authorization', auth).send({ name });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function addPaddock(auth: string, farmId: string): Promise<string> {
  const res = await request(app)
    .post(`/api/farms/${farmId}/paddocks`)
    .set('Authorization', auth)
    .send({ type: 'Feature', geometry: POLYGON, properties: { name: 'P' } });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function addPoint(auth: string, farmId: string): Promise<string> {
  const res = await request(app)
    .post(`/api/farms/${farmId}/features`)
    .set('Authorization', auth)
    .send({ type: 'Feature', geometry: POINT, properties: { type: 'trough', name: 'T' } });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

beforeEach(async () => {
  await truncateAll();
  resetJwksCache();
  usersOn();
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await db.end();
  await closePool();
});

describe('PT33 users mode — A cannot see or change B', () => {
  it('lists only the caller’s farms; a member of nothing sees nothing', async () => {
    const a = await makeFarm(A, 'A-Station');
    const b = await makeFarm(B, 'B-Station');

    const la = await request(app).get('/api/farms').set('Authorization', A);
    expect(la.status).toBe(200);
    expect(la.body.map((f: { id: string }) => f.id)).toEqual([a]);
    expect(JSON.stringify(la.body)).not.toContain('B-Station');

    const lb = await request(app).get('/api/farms').set('Authorization', B);
    expect(lb.body.map((f: { id: string }) => f.id)).toEqual([b]);

    const lc = await request(app).get('/api/farms').set('Authorization', C);
    expect(lc.status).toBe(200);
    expect(lc.body).toEqual([]);
  });

  it('GET / PATCH / DELETE on B’s farm by A → 404, and no rows change', async () => {
    const b = await makeFarm(B, 'B-Station');
    await addPaddock(B, b);
    const before = {
      farms: await count('farms WHERE id = $1 AND name = $2', [b, 'B-Station']),
      paddocks: await count('paddocks WHERE farm_id = $1', [b]),
    };
    expect(before).toEqual({ farms: 1, paddocks: 1 });

    const get = await request(app).get(`/api/farms/${b}`).set('Authorization', A);
    expect(get.status).toBe(404);
    expect(JSON.stringify(get.body)).not.toContain('B-Station');

    const patch = await request(app).patch(`/api/farms/${b}`).set('Authorization', A).send({ name: 'pwned' });
    expect(patch.status).toBe(404);
    const del = await request(app).delete(`/api/farms/${b}`).set('Authorization', A);
    expect(del.status).toBe(404);

    // Nested routes too: reading or writing B's paddocks through the farm URL.
    expect((await request(app).get(`/api/farms/${b}/paddocks`).set('Authorization', A)).status).toBe(404);
    const pPost = await request(app)
      .post(`/api/farms/${b}/paddocks`)
      .set('Authorization', A)
      .send({ type: 'Feature', geometry: POLYGON, properties: { name: 'X' } });
    expect(pPost.status).toBe(404);

    const after = {
      farms: await count('farms WHERE id = $1 AND name = $2', [b, 'B-Station']),
      paddocks: await count('paddocks WHERE farm_id = $1', [b]),
    };
    expect(after).toEqual(before);
  });

  it('an If-Match PATCH through A’s farm URL cannot probe B’s record (404, not 412)', async () => {
    const a = await makeFarm(A, 'A-Station');
    const b = await makeFarm(B, 'B-Station');
    const bp = await addPaddock(B, b);
    const res = await request(app)
      .patch(`/api/farms/${a}/paddocks/${bp}`)
      .set('Authorization', A)
      .set('If-Match', '"7"')
      .send({ type: 'Feature', geometry: POLYGON, properties: { name: 'X' } });
    expect(res.status).toBe(404);
  });

  it('membership grants access, viewer is read-only, owner removal revokes it', async () => {
    const a = await makeFarm(A, 'A-Station');

    // Only an owner manages members.
    const byB = await request(app).post(`/api/farms/${a}/members`).set('Authorization', B).send({ user_id: USER_B });
    expect(byB.status).toBe(404);

    const add = await request(app)
      .post(`/api/farms/${a}/members`)
      .set('Authorization', A)
      .send({ user_id: USER_B, role: 'viewer' });
    expect(add.status).toBe(201);

    const lb = await request(app).get('/api/farms').set('Authorization', B);
    expect(lb.body.map((f: { id: string }) => f.id)).toEqual([a]);
    expect((await request(app).get(`/api/farms/${a}/paddocks`).set('Authorization', B)).status).toBe(200);

    // viewer: no writes
    const w = await request(app).patch(`/api/farms/${a}`).set('Authorization', B).send({ name: 'nope' });
    expect(w.status).toBe(403);

    // editor: writes, but cannot delete the farm or manage members
    await request(app).post(`/api/farms/${a}/members`).set('Authorization', A).send({ user_id: USER_B, role: 'editor' });
    expect((await request(app).patch(`/api/farms/${a}`).set('Authorization', B).send({ name: 'Renamed' })).status).toBe(200);
    expect((await request(app).delete(`/api/farms/${a}`).set('Authorization', B)).status).toBe(403);
    expect(await count('farms WHERE id = $1', [a])).toBe(1);
    expect(
      (await request(app).post(`/api/farms/${a}/members`).set('Authorization', B).send({ user_id: USER_C })).status,
    ).toBe(403);

    // last owner cannot be removed
    expect((await request(app).delete(`/api/farms/${a}/members/${USER_A}`).set('Authorization', A)).status).toBe(409);

    // revoke
    expect((await request(app).delete(`/api/farms/${a}/members/${USER_B}`).set('Authorization', A)).status).toBe(204);
    const gone = await request(app).get('/api/farms').set('Authorization', B);
    expect(gone.body).toEqual([]);
    expect((await request(app).get(`/api/farms/${a}`).set('Authorization', B)).status).toBe(404);
  });

  it('the owner can delete their own farm', async () => {
    const a = await makeFarm(A, 'A-Station');
    expect((await request(app).delete(`/api/farms/${a}`).set('Authorization', A)).status).toBe(204);
    expect(await count('farm_members WHERE farm_id = $1', [a])).toBe(0);
  });
});

describe('PT33 users mode — photos', () => {
  it('upload needs write on the feature’s farm; list/file/delete are scoped', async () => {
    const a = await makeFarm(A, 'A-Station');
    const fa = await addPoint(A, a);

    const up = await request(app)
      .post('/api/photos')
      .set('Authorization', A)
      .field('feature_id', fa)
      .attach('photo', JPEG, { filename: 'a.jpg', contentType: 'image/jpeg' });
    expect(up.status).toBe(201);
    const photoId = up.body.id as string;

    // B cannot attach to A's feature, and nothing is stored.
    const before = await count('photos');
    const upB = await request(app)
      .post('/api/photos')
      .set('Authorization', B)
      .field('feature_id', fa)
      .attach('photo', JPEG, { filename: 'b.jpg', contentType: 'image/jpeg' });
    expect(upB.status).toBe(404);
    // A signed-in upload with no feature would be an orphan nobody can see.
    const noFeature = await request(app)
      .post('/api/photos')
      .set('Authorization', A)
      .attach('photo', JPEG, { filename: 'c.jpg', contentType: 'image/jpeg' });
    expect(noFeature.status).toBe(400);
    expect(await count('photos')).toBe(before);

    expect((await request(app).get('/api/photos').set('Authorization', A)).body).toHaveLength(1);
    expect((await request(app).get('/api/photos').set('Authorization', B)).body).toEqual([]);
    expect((await request(app).get(`/api/photos?feature_id=${fa}`).set('Authorization', B)).status).toBe(404);
    expect((await request(app).get(`/api/photos?farm_id=${a}`).set('Authorization', B)).status).toBe(404);

    expect((await request(app).get(`/api/photos/file/${photoId}`).set('Authorization', A)).status).toBe(200);
    expect((await request(app).get(`/api/photos/file/${photoId}`).set('Authorization', B)).status).toBe(404);

    expect((await request(app).delete(`/api/photos/${photoId}`).set('Authorization', B)).status).toBe(404);
    expect(await count('photos WHERE id = $1', [photoId])).toBe(1);
    expect((await request(app).delete(`/api/photos/${photoId}`).set('Authorization', A)).status).toBe(204);
  });

  it('an <img>-style request carrying only the session cookie loads the photo', async () => {
    const a = await makeFarm(A, 'A-Station');
    const fa = await addPoint(A, a);
    const up = await request(app)
      .post('/api/photos')
      .set('Authorization', A)
      .field('feature_id', fa)
      .attach('photo', JPEG, { filename: 'a.jpg', contentType: 'image/jpeg' });

    const sa = await request(app).post('/api/auth/session').send({ access_token: jwt(USER_A) });
    expect(sa.status).toBe(201);
    const cookieA = (sa.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookieA).toMatch(/^pt_session=.+; Path=\/api; HttpOnly; SameSite=Lax; Max-Age=2592000/);
    const sb = await request(app).post('/api/auth/session').send({ access_token: jwt(USER_B) });
    const cookieB = (sb.headers['set-cookie'] as unknown as string[])[0]!;

    const img = await request(app).get(`/api/photos/file/${up.body.id}`).set('Cookie', cookieA.split(';')[0]!);
    expect(img.status).toBe(200);
    const imgB = await request(app).get(`/api/photos/file/${up.body.id}`).set('Cookie', cookieB.split(';')[0]!);
    expect(imgB.status).toBe(404);

    const me = await request(app).get('/api/auth/me').set('Cookie', cookieA.split(';')[0]!);
    expect(me.body).toMatchObject({ kind: 'user', user_id: USER_A });

    // No credentials at all → 401 (reads are locked in users mode).
    expect((await request(app).get(`/api/photos/file/${up.body.id}`)).status).toBe(401);
  });
});

describe('PT33 users mode — credentials that must not work', () => {
  it('rejects expired, wrongly-signed, wrong-audience, wrong-issuer, anon-role and alg=none tokens', async () => {
    await makeFarm(A, 'A-Station');
    const bad = [
      jwt(USER_A, { expIn: -10 }),
      jwt(USER_A, { key: rogue.privateKey }),
      jwt(USER_A, { aud: 'other' }),
      jwt(USER_A, { iss: 'https://evil.supabase.co/auth/v1' }),
      jwt(USER_A, { role: 'anon' }),
      `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: USER_A, aud: 'authenticated', role: 'authenticated', exp: 9e9 })}.`,
      // HS256 signed with a guessed secret while no SUPABASE_JWT_SECRET is configured
      (() => {
        const h = b64({ alg: 'HS256', typ: 'JWT' });
        const p = b64({ sub: USER_A, aud: 'authenticated', role: 'authenticated', exp: 9e9 });
        return `${h}.${p}.${createHmac('sha256', '').update(`${h}.${p}`).digest('base64url')}`;
      })(),
    ];
    for (const t of bad) {
      const res = await request(app).get('/api/farms').set('Authorization', `Bearer ${t}`);
      expect(res.status, t.slice(0, 30)).toBe(401);
    }
    expect((await request(app).get('/api/farms')).status).toBe(401);
    // Session exchange refuses a bad token too.
    expect((await request(app).post('/api/auth/session').send({ access_token: bad[1] })).status).toBe(401);
    // A tampered cookie is not a session.
    expect((await request(app).get('/api/farms').set('Cookie', 'pt_session=eyJzdWIiOiJ4In0.AAAA')).status).toBe(401);
  });

  it('a cookie-authenticated write from a foreign Origin is refused', async () => {
    const sa = await request(app).post('/api/auth/session').send({ access_token: jwt(USER_A) });
    const cookie = (sa.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    const res = await request(app)
      .post('/api/farms')
      .set('Cookie', cookie)
      .set('Origin', 'https://evil.example')
      .send({ name: 'csrf' });
    expect(res.status).toBe(403);
    expect(await count('farms')).toBe(0);
  });

  it('the legacy write token still works for one release, and sees every farm', async () => {
    await makeFarm(A, 'A-Station');
    await makeFarm(B, 'B-Station');
    const res = await request(app).get('/api/farms').set('Authorization', 'Bearer legacy-write-token');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });
});

describe('PT33 CORS', () => {
  it('users mode: a foreign origin gets no Access-Control-Allow-Origin', async () => {
    const res = await request(app).get('/api/health').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('CORS_ORIGINS: listed origin allowed with credentials, others not', async () => {
    vi.stubEnv('CORS_ORIGINS', 'https://poly.example');
    const ok = await request(app).get('/api/health').set('Origin', 'https://poly.example');
    expect(ok.headers['access-control-allow-origin']).toBe('https://poly.example');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const no = await request(app).get('/api/health').set('Origin', 'https://evil.example');
    expect(no.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('users mode off: CORS is unchanged (*)', async () => {
    vi.stubEnv('AUTH_USERS', '');
    const res = await request(app).get('/api/health').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});

describe('PT33 users mode OFF — behaviour unchanged', () => {
  it('ignores JWTs and membership: open mode lists every farm, members routes 404', async () => {
    vi.stubEnv('AUTH_USERS', '');
    vi.stubEnv('API_WRITE_TOKEN', '');
    await request(app).post('/api/farms').send({ name: 'One' });
    await request(app).post('/api/farms').send({ name: 'Two' });
    const res = await request(app).get('/api/farms').set('Authorization', A);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(await count('farm_members')).toBe(0);
    const farmId = res.body[0].id as string;
    expect((await request(app).get(`/api/farms/${farmId}/members`)).status).toBe(404);
    expect((await request(app).post('/api/auth/session').send({ access_token: jwt(USER_A) })).status).toBe(404);
  });

  it('token mode still gates writes exactly as before', async () => {
    vi.stubEnv('AUTH_USERS', '');
    vi.stubEnv('API_WRITE_TOKEN', 'tok');
    // A valid Supabase JWT is NOT a write token when users mode is off.
    expect((await request(app).post('/api/farms').set('Authorization', A).send({ name: 'x' })).status).toBe(401);
    expect((await request(app).post('/api/farms').set('Authorization', 'Bearer tok').send({ name: 'x' })).status).toBe(201);
  });
});

describe('PT33 review — who may create a farm in users mode (AUTH_FARM_CREATORS)', () => {
  const create = (auth: string, name = 'New') => request(app).post('/api/farms').set('Authorization', auth).send({ name });

  it('allowed by user id: 201, and the creator owns it', async () => {
    vi.stubEnv('AUTH_FARM_CREATORS', USER_A.toUpperCase()); // ids match case-insensitively
    const res = await create(A);
    expect(res.status).toBe(201);
    expect(await count("farm_members WHERE user_id = $1 AND role = 'owner'", [USER_A])).toBe(1);
  });

  it('allowed by email (the token\'s email claim), case-insensitively', async () => {
    vi.stubEnv('AUTH_FARM_CREATORS', ` someone@else.test , ${USER_C.slice(0, 4).toUpperCase()}@EXAMPLE.TEST `);
    expect((await create(C)).status).toBe(201);
  });

  it('not on the list: 403, a sentence, and no farm or membership row', async () => {
    vi.stubEnv('AUTH_FARM_CREATORS', USER_A);
    const res = await create(B);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not allowed to create farms/);
    expect(res.body.error).not.toMatch(/AUTH_FARM_CREATORS/); // env names are for the log
    expect(await count('farms')).toBe(0);
    expect(await count('farm_members')).toBe(0);
  });

  it('unset: fails closed with 403 for everyone signed in, including would-be owners', async () => {
    vi.stubEnv('AUTH_FARM_CREATORS', '');
    for (const who of [A, B, C]) {
      const res = await create(who);
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/switched off/);
    }
    expect(await count('farms')).toBe(0);
  });

  it('does not stop an existing member working on a farm they were added to', async () => {
    const a = await makeFarm(A, 'A-Station');
    await request(app).post(`/api/farms/${a}/members`).set('Authorization', A).send({ user_id: USER_C, role: 'editor' });
    vi.stubEnv('AUTH_FARM_CREATORS', USER_A);
    expect((await create(C)).status).toBe(403);
    expect((await request(app).patch(`/api/farms/${a}`).set('Authorization', C).send({ name: 'Renamed' })).status).toBe(200);
  });

  it('token mode is unchanged: the list is not consulted', async () => {
    vi.stubEnv('AUTH_USERS', '');
    vi.stubEnv('AUTH_FARM_CREATORS', '');
    vi.stubEnv('API_WRITE_TOKEN', 'tok');
    expect((await create('Bearer tok')).status).toBe(201);
  });
});

describe('PT33 review — leaving a farm', () => {
  it('a viewer can remove themselves, but nobody else', async () => {
    const a = await makeFarm(A, 'A-Station');
    await request(app).post(`/api/farms/${a}/members`).set('Authorization', A).send({ user_id: USER_B, role: 'viewer' });
    await request(app).post(`/api/farms/${a}/members`).set('Authorization', A).send({ user_id: USER_C, role: 'viewer' });

    // Still read-only for everything else, including removing another member.
    expect((await request(app).delete(`/api/farms/${a}/members/${USER_C}`).set('Authorization', B)).status).toBe(403);
    expect((await request(app).delete(`/api/farms/${a}/members/${USER_A}`).set('Authorization', B)).status).toBe(403);
    // A trailing slash is the same route to Express; it must not dodge the check either way.
    expect((await request(app).delete(`/api/farms/${a}/members/${USER_B}/`).set('Authorization', B)).status).toBe(204);
    expect(await count('farm_members WHERE farm_id = $1 AND user_id = $2', [a, USER_B])).toBe(0);
    expect((await request(app).get(`/api/farms/${a}`).set('Authorization', B)).status).toBe(404);

    expect((await request(app).delete(`/api/farms/${a}/members/${USER_C}`).set('Authorization', C)).status).toBe(204);
    expect(await count('farm_members WHERE farm_id = $1', [a])).toBe(1);
  });

  it('a non-member still gets 404 for "leaving" a farm they are not in', async () => {
    const a = await makeFarm(A, 'A-Station');
    expect((await request(app).delete(`/api/farms/${a}/members/${USER_C}`).set('Authorization', C)).status).toBe(404);
  });
});

describe('PT33 review — a photo client_id is scoped to farms the caller can write', () => {
  const upload = (auth: string, featureId: string, clientId: string) =>
    request(app)
      .post('/api/photos')
      .set('Authorization', auth)
      .field('feature_id', featureId)
      .field('client_id', clientId)
      .attach('photo', JPEG, { filename: 'p.jpg', contentType: 'image/jpeg' });

  it("another farm's client_id gets 409, never that farm's row; the owner's retry still dedupes", async () => {
    const a = await makeFarm(A, 'A-Station');
    const b = await makeFarm(B, 'B-Station');
    const fa = await addPoint(A, a);
    const fb = await addPoint(B, b);
    const clientId = randomUUID();

    const first = await upload(A, fa, clientId);
    expect(first.status).toBe(201);

    const probe = await upload(B, fb, clientId);
    expect(probe.status).toBe(409);
    expect(JSON.stringify(probe.body)).not.toContain(first.body.id);
    expect(JSON.stringify(probe.body)).not.toContain(fa);
    expect(await count('photos')).toBe(1);

    const retry = await upload(A, fa, clientId);
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);
    expect(await count('photos')).toBe(1);
  });

  it('a viewer of the photo\'s farm cannot read it back through client_id either', async () => {
    const a = await makeFarm(A, 'A-Station');
    const b = await makeFarm(B, 'B-Station');
    const fa = await addPoint(A, a);
    const fb = await addPoint(B, b);
    await request(app).post(`/api/farms/${a}/members`).set('Authorization', A).send({ user_id: USER_B, role: 'viewer' });
    const clientId = randomUUID();
    expect((await upload(A, fa, clientId)).status).toBe(201);
    expect((await upload(B, fb, clientId)).status).toBe(409);
  });
});
