# Deploying Poly_Tracker to a public URL (Render)

This gets the full stack — managed **PostGIS**, the **Express API**, and the
**Vite PWA** — onto a stable `*.onrender.com` HTTPS URL with no dependency on
your local machine. The local `docker compose` stacks are untouched; everything
here is additive (see [render.yaml](render.yaml)).

> The older Cloudflare-named-tunnel path (`scripts/tunnel.ps1`) still works and
> is documented in `.env.example` — but it needs your PC + Docker running 24/7.
> Render replaces that with an always-on address.

## What Render gives you

| URL | Serves |
|-----|--------|
| `https://gibbhubb-poly-tracker.onrender.com` | the app (share **this** one) |
| `https://gibbhubb-poly-tracker-api.onrender.com` | the API (`/api/health` for a liveness check) |

> **`*.onrender.com` is a global namespace across all Render users** — plain
> `poly-tracker` is already taken (you'll see a "service suspended" page for
> it; not ours). `render.yaml` uses the distinctive `gibbhubb-*` names to avoid
> the clash. If even those are taken, rename them in `render.yaml` to any free
> name (or attach a custom domain, §Notes). The **actual** assigned URLs are
> shown in the Render dashboard after Apply — always trust those.

## One-time setup

Everything below is **Max-owned** — it needs an account and secrets the repo
must never contain.

### 1. Create the Blueprint
1. Sign in at <https://render.com> and connect the `GibbHubb/Poly_Tracker-`
   GitHub repo (Account → GitHub).
2. **New +** → **Blueprint** → select this repo → Render reads `render.yaml` and
   shows **two** resources: `gibbhubb-poly-tracker-api` and `gibbhubb-poly-tracker`.
   There is no database resource — see §3.
3. When prompted for the `sync: false` env vars, paste:
   - **`DATABASE_URL`** (on the **api** service) — the Supabase pooler URL. See §3.
   - **`VITE_MAPBOX_TOKEN`** (on the **web** service) — your public
     Mapbox token (`pk.…`) from <https://account.mapbox.com/access-tokens/>.
   - **`VITE_API_BASE`** (on the **web** service) — see §2.
4. Click **Apply**. Render builds the API image and the static site. First build
   takes a few minutes.

### 2. Point the frontend at the API (after first deploy)
`VITE_API_BASE` is intentionally left unset in `render.yaml` — the API's final
hostname isn't known until it deploys. Once the API service is live:
1. Copy its URL from the dashboard (e.g. `https://gibbhubb-poly-tracker-api.onrender.com`).
2. On the **`gibbhubb-poly-tracker`** (web) service → Environment, set
   **`VITE_API_BASE`** = that URL **+ `/api`** (e.g.
   `https://gibbhubb-poly-tracker-api.onrender.com/api`).
3. **Manual Deploy → Deploy latest commit** on the web service (Vite bakes env
   at build time, so it must rebuild). Skipping this leaves the app calling the
   wrong origin and every API request fails.

### 3. The database (Supabase — already provisioned)
**The database is not on Render.** Render's free Postgres has a hard ~30-day
delete clock that no keepalive can stop, and it fired: the original
`poly-tracker-db` was deleted and the API started returning
`getaddrinfo ENOTFOUND dpg-…`.

The DB now lives in the existing **free Supabase project**, in a dedicated
`poly` schema owned by a `poly_app` role scoped to that schema only. No hard
expiry, and the Our_Menu keepalive already keeps the project awake.

**Already done (2026-08-18) — no action needed:** PostGIS 3.3 enabled, `poly`
schema created, all 5 tables + GIST indexes applied at SRID 4326, `poly_app`
role created and granted, verified permission-denied on `public.*` and `auth.*`.

The only step is to paste `DATABASE_URL` on the api service. It is recorded as
`POLY_TRACKER_DATABASE_URL` in `backlog_bandit/.env` (gitignored). Shape:

```
postgresql://poly_app.<project-ref>:<password>@aws-1-eu-west-1.pooler.supabase.com:5432/postgres
```

⚠️ **Three things about that URL are load-bearing:**
- **Use the pooler host**, not `db.<ref>.supabase.co` — the direct host is
  **IPv6-only** and Render's free tier is IPv4-only outbound.
- **Port 5432 (session mode)**, not 6543 — the `poly_app` role's `search_path`
  must persist, since the schema files use unqualified table names.
- **No `?sslmode=require`.** pg's connection-string parser then builds its own
  verifying TLS config, overriding `rejectUnauthorized: false` in
  `api/src/db.ts`, and the API dies with `SELF_SIGNED_CERT_IN_CHAIN`. TLS comes
  from `PGSSL=true`. Measured: with the param → 503; without → 200.

### 4. Verify
- Open the web app's URL (`https://gibbhubb-poly-tracker.onrender.com`) — the map loads over HTTPS.
- Create a farm, draw a paddock/pipe/point, hard-reload → the geometry persists
  (proves the API is writing to the managed PostGIS DB).
- **Export PDF** downloads an A3 map.
- Toggle imagery Mapbox ⇄ Esri (Esri needs no token).

## Notes & gotchas

- **Free tier trade-offs.** Free web services **spin down when idle** (first hit
  after a pause cold-starts in ~30–60s; measured 12.5s cold vs 0.58s warm).
  This stack is deliberately **100% free** — the database expiry that used to
  live here is gone now that Postgres is on Supabase, and the cold start is the
  only remaining free-tier cost. Do not "fix" it by moving to a paid plan.
- **`/api/health` queries the database.** It used to return a hardcoded
  `{ok:true}`, which is exactly why a deleted database read as healthy for days.
  It now runs `SELECT 1` and returns **503** `{"ok":false,"db":"down"}` when the
  DB is unreachable. That means Render will correctly mark the service unhealthy
  if the DB dies — intended, since the app is useless without it.
- **Custom domain.** To replace `gibbhubb-poly-tracker.onrender.com` with your
  own (e.g. `polytracker.<yourdomain>`), add it on the web service → Settings →
  Custom Domains and point a CNAME at Render. Then set `VITE_API_BASE` to the
  API's domain and redeploy the web service.
- **SSL.** The API connects to the managed DB with TLS (`PGSSL=true` in
  `render.yaml`). If it ever logs an SSL connection error, flip that to `false`.
- **Mapbox token exposure.** The `pk.…` token ships in the client bundle (normal
  for Mapbox GL). Lock it down with URL restrictions in the Mapbox dashboard, or
  rely on the token-free **Esri** basemap as the public default.
- **Photos are ephemeral.** `/data/photos` is wiped on redeploy without a paid
  disk. Geometry + PDF export (the demo surface) are unaffected. A durable photo
  store is a follow-up.
- **Public API is open CRUD.** The auth gate is off (open mode). To lock writes,
  set `API_WRITE_TOKEN` on the API service and supply it from the client — a
  separate hardening task.

## Tear down

Delete the three resources in the Render dashboard (or the whole Blueprint). No
local artifact or DNS lingers. `git revert` of the deploy commit restores the
repo to tunnel-only public access.
