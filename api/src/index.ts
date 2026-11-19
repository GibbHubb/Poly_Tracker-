import express from 'express';
import cors from 'cors';
import { pathToFileURL } from 'node:url';
import { farmsRouter } from './routes/farms.js';
import { paddocksRouter } from './routes/paddocks.js';
import { polyRunsRouter } from './routes/polyRuns.js';
import { featuresRouter } from './routes/features.js';
import { photosRouter } from './routes/photos.js';
import { importRouter } from './routes/import.js';
import { membersRouter } from './routes/members.js';
import { authRouter } from './routes/auth.js';
import { errorHandler } from './middleware/index.js';
import { allowedOrigins, requireFarmMember, resolveIdentity } from './middleware/authorize.js';
import { assertAuthConfig, usersModeOn } from './lib/identity.js';
import { accessLog, healthStats, log, requestId } from './middleware/observability.js';
import { query } from './db.js';

// PT33 review — refuse to start in users mode without the issuer to check tokens against.
assertAuthConfig();

export const app = express();
// PT35 — before everything else, so even a body-parser refusal has an id and a log line.
app.use(requestId);
app.use(accessLog);
// PT33 — CORS. The SPA and the API share one origin (PT21), so no browser
// caller needs cross-origin access. Evaluated per request:
//   CORS_ORIGINS set   → only those origins, with credentials;
//   AUTH_USERS=on      → no cross-origin access at all (same-origin only);
//   otherwise          → the pre-PT33 `*`, unchanged until users mode ships.
app.use(
  cors((_req, cb) => {
    const list = allowedOrigins();
    if (list.length > 0) cb(null, { origin: list, credentials: true, exposedHeaders: ['x-request-id'] });
    else if (usersModeOn()) cb(null, { origin: false });
    else cb(null, { exposedHeaders: ['x-request-id'] });
  }),
);
app.use(express.json({ limit: '5mb' }));

// PT22: this check MUST touch the database. It previously returned a hardcoded
// {ok:true}, so when Render deleted the free Postgres the service still reported
// healthy for days while every data route was dead.
//
// PT35 — it also answers "what has been failing" without a dashboard login:
// counters and the last few 5xx (ids, route shapes and SQLSTATE codes, never
// messages, because this endpoint is public). Scoped to THIS function instance
// since its start, and it says so; the full text is in the log under the id.
app.get('/api/health', async (_req, res) => {
  try {
    await query('SELECT 1');
    res.json({ ok: true, db: 'up', ...healthStats() });
  } catch (err) {
    // The raw message names the database host; it goes to the log, not the caller.
    const code = (err as { code?: unknown } | null)?.code;
    log({
      level: 'error',
      msg: 'health: database unreachable',
      requestId: String(res.locals.requestId ?? ''),
      code: typeof code === 'string' ? code : undefined,
      error: err instanceof Error ? err.message : String(err),
    });
    // No `code` either (ECONNREFUSED/ENOTFOUND says why); that is in the log.
    res.status(503).json({
      ok: false,
      db: 'down',
      error: 'Database unreachable.',
      requestId: res.locals.requestId,
      ...healthStats(),
    });
  }
});

// Auth gate: mutations require the write token; reads require a read token
// only when one is configured. Open mode (neither set) is a dev-only state —
// PT23 makes production refuse writes outright rather than serve them openly.
//
// PT33 — sign-in routes sit in front of the gate (they are how you get past
// it). `resolveIdentity` is `requireToken` verbatim unless AUTH_USERS=on.
app.use('/api/auth', authRouter);
app.use(resolveIdentity);

// Every /api/farms/:farmId[/...] request: membership check (no-op unless a
// signed-in person is calling). Nested routers already filter by farm_id.
app.use('/api/farms/:farmId', requireFarmMember);
app.use('/api/farms', farmsRouter);
app.use('/api/farms/:farmId/members', membersRouter);
app.use('/api/farms/:farmId/paddocks', paddocksRouter);
app.use('/api/farms/:farmId/poly-runs', polyRunsRouter);
app.use('/api/farms/:farmId/features', featuresRouter);
app.use('/api/photos', photosRouter);
app.use('/api/import', importRouter);

app.use(errorHandler);

// Only bind a port when run directly (not when imported by tests).
const isMain =
  import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

if (isMain) {
  if (usersModeOn()) {
    console.log('[api] AUTH_USERS=on — per-user sign-in; farms are scoped by farm_members');
  }
  const writeToken = process.env.API_WRITE_TOKEN || process.env.API_TOKEN;
  const readToken = process.env.API_READ_TOKEN;
  if (!writeToken && !readToken) {
    // PT23 — say which of the two states this actually is. In production the
    // gate is not "disabled", it is refusing every write with a 503, and the
    // operator needs to read that as "set API_WRITE_TOKEN", not as an outage.
    if (process.env.NODE_ENV === 'production') {
      console.warn(
        '[api] API_WRITE_TOKEN is not set — all writes will be refused with 503. ' +
          'Set it on this service to enable them.',
      );
    } else {
      console.warn(
        '[api] no API tokens set — auth gate DISABLED (open mode: reads AND writes are public)',
      );
    }
  } else {
    console.log(
      `[api] auth gate: writes ${writeToken ? 'REQUIRE a token' : 'OPEN (no write token)'}; ` +
        `reads ${readToken ? 'REQUIRE a token' : 'OPEN'}`,
    );
  }
  // Render (and most PaaS) inject the bind port as $PORT; local compose sets
  // API_PORT. Prefer PORT so the managed deploy's health check reaches us.
  const port = Number(process.env.PORT ?? process.env.API_PORT ?? 3001);
  app.listen(port, () => {
    console.log(`[api] listening on :${port}`);
  });
}
