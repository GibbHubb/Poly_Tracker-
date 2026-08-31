# Deploying Poly_Tracker to a public URL (Vercel)

**Live:** https://poly-tracker-ashy.vercel.app

One Vercel project serves both halves: the Vite SPA as a static build, and the
existing Express app as a **single serverless function** mounted at `/api/*`.

That is the whole design decision, and it is worth understanding before changing
it. Two separate deployments (the old Render shape) means a CORS policy to
maintain, a build-time `VITE_API_BASE` to bake into the bundle, and a class of
bug where the SPA's catch-all rewrite answers an API call with `index.html` at
**HTTP 200** — a fetch that "succeeds" and returns HTML. One origin deletes all
three: `web/src/lib/api.ts`'s existing `VITE_API_BASE || '/api'` fallback becomes
*correct*, so there is no API URL to get wrong and no origin to allow.

**Leave `VITE_API_BASE` unset on Vercel.** Setting it is how you re-introduce the
problem.

## The moving parts

| File | What it does |
|---|---|
| `vercel.json` | static build from `web/`, `/api/*` → the function, SPA fallback for everything else, `no-cache` on `sw.js` |
| `api/src/vercel.ts` | re-exports the Express `app` as the function handler. It lives inside `src/` because `tsconfig` sets `rootDir=src` |
| `api/src/db.ts` | caps the pool at 1 when `VERCEL` is set — a serverless deploy runs many short-lived instances against one Postgres, and a default pool of 10 per instance multiplies into connection exhaustion |

## One-time setup

1. Import the repo as a Vercel project. No framework preset, no root directory —
   `vercel.json` describes the build.
2. Set these environment variables (Production + Preview):

   | Variable | Notes |
   |---|---|
   | `DATABASE_URL` | see the shape below — three details are load-bearing |
   | `PGSSL` | `true` |
   | `API_WRITE_TOKEN` | any long random string; writes fail closed without it (PT23) |
   | `VITE_MAPBOX_TOKEN` | `pk.…`, baked into the client bundle at build time |

   **Do not set `VITE_API_BASE`.**
3. Push to `main`. Vercel builds from git.

⚠️ **Every deployment before 2026-08-31 was `vercel --prod` from somebody's
working directory, and `vercel.json` was never committed** — so nothing in the
repository reproduced the running site, and the first git-triggered build would
have served an SPA with no API. If you find yourself deploying from the CLI to
make something work, commit whatever made it work instead.

## The database (Supabase — already provisioned)

**The database is not on the app platform.** Render's free Postgres has a hard
~30-day delete clock that no keepalive can stop, and it fired: the original
`poly-tracker-db` was deleted and the API started returning
`getaddrinfo ENOTFOUND dpg-…` (PT22).

The DB lives in the existing **free Supabase project**, in a dedicated `poly`
schema owned by a `poly_app` role scoped to that schema only. No hard expiry.

**Already done (2026-08-18) — no action needed:** PostGIS 3.3 enabled, `poly`
schema created, all 5 tables + GIST indexes applied at SRID 4326, `poly_app`
role created and granted, verified permission-denied on `public.*` and `auth.*`.

The only step is pasting `DATABASE_URL` into Vercel. It is recorded as
`POLY_TRACKER_DATABASE_URL` in `backlog_bandit/.env` (gitignored). Shape:

```
postgresql://poly_app.<project-ref>:<password>@aws-1-eu-west-1.pooler.supabase.com:5432/postgres
```

⚠️ **Three things about that URL are load-bearing:**
- **Use the pooler host**, not `db.<ref>.supabase.co` — the direct host is
  **IPv6-only**.
- **Either pooler port works — measured, twice.** The original note here said
  5432 (session mode) was *required* so the `poly_app` role's `search_path`
  persists, since the schema files use unqualified table names. That worried
  PT21, because serverless wants transaction mode (6543) for its many
  short-lived connections. It is a non-problem: Postgres applies role defaults
  at connection start, so **both ports report `search_path = poly, extensions`**,
  and on both an unqualified `SELECT … FROM farms` and a parameterized PostGIS
  query succeed. Measured 2026-08-28 and again 2026-08-31.
- **No `?sslmode=require`.** pg's connection-string parser then builds its own
  verifying TLS config, overriding `rejectUnauthorized: false` in
  `api/src/db.ts`, and the API dies with `SELF_SIGNED_CERT_IN_CHAIN`. TLS comes
  from `PGSSL=true`. Measured: with the param → 503; without → 200.

## Verify

Do not accept `/api/health` as proof the app works — it proves the function can
reach Postgres, not that anyone can draw a paddock and still have it tomorrow.
The harness that walks the whole thing in a real browser lives in the
`backlog_bandit` repo (harnesses live there, not here, because they carry
credentials from that repo's `.env`):

```
python scripts/pt21_verify.py --url https://poly-tracker-ashy.vercel.app
```

19 checks, all against the deployed origin: health is JSON (not HTML at 200),
writes refuse without a bearer token and succeed with one, **draw → save →
reload → still there** read back from the API *and* visible on the reloaded
page, a second browser session sees it, Esri tiles really arrive when you switch
provider, PDF export returns a real `%PDF-`, and the shell still loads with the
network disabled. It creates a farm named `PT21 verify <time>` and deletes it
afterwards.

To prove the failure path, point a **preview** deployment at a dead host and
confirm `/api/health` → **503** with `getaddrinfo ENOTFOUND`. Use a
branch-scoped environment variable so only that branch is affected.

## Notes & gotchas

- **`/api/health` queries the database.** It used to return a hardcoded
  `{ok:true}`, which is exactly why a deleted database read as healthy for days.
  It now runs `SELECT 1` and returns **503** `{"ok":false,"db":"down"}` when the
  DB is unreachable.
- **Cold starts** replace Render's 30–60s spin-up with a function cold start of
  a second or two. Strictly better, and the stack is still 100% free. Do not
  "fix" it by moving to a paid plan.
- **Photo upload does not work on this platform, and says so.** `photos.ts`
  writes through `multer.diskStorage()`; Vercel's filesystem is read-only
  outside `/tmp` and ephemeral anyway. It used to `mkdirSync` at import time,
  which threw `EROFS` while the module loaded and took down **every** route in
  the app. It now records the failure and refuses uploads with a 503 naming the
  reason. A real object store is **PT24**.
- **The basemap does not fall back.** With `VITE_MAPBOX_TOKEN` unset the app
  still asks Mapbox with an empty `access_token` and the map goes blank — Esri
  is a provider you *choose* in the layer switcher, not an automatic fallback
  (**PT25**).
- **Mapbox token exposure.** The `pk.…` token ships in the client bundle (normal
  for Mapbox GL). Lock it down with URL restrictions in the Mapbox dashboard.
- **Writes fail closed in production (PT23).** The API used to serve
  unauthenticated CRUD whenever `API_WRITE_TOKEN` was unset — a forgotten
  dashboard field was the only thing between the public URL and "anyone can
  delete every farm". With `NODE_ENV=production` and no write token, every
  `POST`/`PATCH`/`DELETE` answers **503 `{"error":"Writes are disabled…"}`**.
  With a token configured and none sent, it is **401**. Reads stay open — the
  map is meant to be viewable.

  To turn writes on: set `API_WRITE_TOKEN` on the Vercel project, open the SPA →
  **Settings**, and paste the same value as the API token; it is kept in
  `localStorage` and sent as `Authorization: Bearer …`. **Do not** ship it as a
  `VITE_*` build var — Vite bakes those into the public bundle, so the "secret"
  would be readable by anyone who opens devtools.

  Local dev and the test suite are unaffected: without `NODE_ENV=production`
  the gate stays in open mode exactly as before.

## Local development is unchanged

`docker compose up --build` still brings up db + api + web + nginx exactly as
before; none of the Vercel plumbing touches it. Verified 2026-08-31.

## Tear down

Delete the Vercel project. The database is not part of it and is unaffected —
the Supabase `poly` schema outlives any deployment. `git revert` of the platform
commit restores the repo to tunnel-only public access.
