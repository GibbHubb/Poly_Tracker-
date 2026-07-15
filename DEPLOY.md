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
   shows three resources: `poly-tracker-db`, `poly-tracker-api`, `poly-tracker`.
3. When prompted for the `sync: false` env vars, paste:
   - **`VITE_MAPBOX_TOKEN`** (on the `poly-tracker` web service) — your public
     Mapbox token (`pk.…`) from <https://account.mapbox.com/access-tokens/>.
4. Click **Apply**. Render provisions the DB, builds the API image, and builds
   the static site. First build takes a few minutes.

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

### 3. Initialise the database schema (once)
Render does **not** run `db/init/*.sql` for you. After the DB shows *Available*,
copy its **External Connection String** (Dashboard → `poly-tracker-db` →
Connect → External), then from your machine:

```bash
cd api
npm ci                       # installs the pg driver locally (once)
DATABASE_URL="<external connection string>" PGSSL=true npm run db:init
```

Expected output:
```
✓ extensions ensured (postgis, pgcrypto)
✓ schema applied (5 tables + GIST indexes, SRID 4326)
✓ postgis_version: 3.x …
```
It's idempotent — safe to re-run (it no-ops if the schema is already there).

### 4. Verify
- Open the web app's URL (`https://gibbhubb-poly-tracker.onrender.com`) — the map loads over HTTPS.
- Create a farm, draw a paddock/pipe/point, hard-reload → the geometry persists
  (proves the API is writing to the managed PostGIS DB).
- **Export PDF** downloads an A3 map.
- Toggle imagery Mapbox ⇄ Esri (Esri needs no token).

## Notes & gotchas

- **Free tier trade-offs.** Free web services **spin down when idle** (first hit
  after a pause cold-starts in ~30–60s). The free Postgres instance **expires
  after ~30 days**. For an always-warm, durable deploy, change both `plan: free`
  lines in `render.yaml` to `plan: starter` (a few $/month) and re-Apply.
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
