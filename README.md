# Poly Tracker

Mobile-first, offline-capable GIS web app for tracking poly pipe runs, water
troughs, turkey nests, bores, and paddock boundaries on cattle farms. Draw
features on a satellite map; export high-resolution PDF maps for documentation.

## Stack

| Layer    | Tech |
|----------|------|
| Frontend | React 18 + Vite + TypeScript, MapLibre GL JS, mapbox-gl-draw, Tailwind, Workbox PWA, Dexie, React Router, Zustand |
| Backend  | Node 20 + Express + TypeScript, node-postgres, Zod, Multer, Puppeteer |
| Database | PostgreSQL 16 + PostGIS 3.4 (all geometries SRID 4326) |
| Infra    | Docker Compose: `db`, `api`, `web`, `nginx` |

## Prerequisites

- Docker Desktop / Docker Engine 24+ with Compose v2
- A Mapbox access token (free tier is fine) — see below
- ~2 GB free disk (the API image bundles Chromium for PDF export)

## Get a Mapbox token

1. Sign up at <https://account.mapbox.com/>.
2. Open <https://account.mapbox.com/access-tokens/>.
3. Copy the **default public token** (`pk.…`) or create a new one with the
   default public scopes.
4. Paste it into `.env` as `MAPBOX_TOKEN`.

## Env setup

```bash
cp .env.example .env
# edit .env and set MAPBOX_TOKEN=pk.your_real_token
```

| Var | Purpose | Default |
|-----|---------|---------|
| `DATABASE_URL` | Postgres DSN used by the API | `postgres://poly:poly@db:5432/poly_tracker` |
| `MAPBOX_TOKEN` | Mapbox satellite tiles + PDF export | — (required) |
| `API_PORT` | API listen port | `3001` |
| `WEB_PORT` | Vite dev server port | `5173` |
| `PHOTO_STORAGE_PATH` | Photo upload dir in the api container | `/data/photos` |

## First run

```bash
docker compose up --build
```

Then open **<http://localhost:8080>** (nginx single-origin entrypoint).

- The web app shows an empty farm list with a **Create farm** button.
- Create a farm, click it → a satellite map centred on Australia opens with
  the draw toolbar (point / line / polygon / trash) on the top-left.
- Drawn polygons become paddocks, lines become poly runs, points become
  features. They persist via the API into PostGIS.

Direct service ports (bypassing nginx) are also exposed: web `:5173`,
api `:3001`, db `:5432`.

## Dev workflow

- Source is bind-mounted; Vite HMR and `tsx watch` reload on change.
- `docker compose logs -f api` / `web` to tail a service.
- Typecheck locally without Docker:
  ```bash
  cd api && npm install && npm run typecheck
  cd web && npm install && npm run typecheck
  ```
- DB schema lives in `db/init/*.sql` and runs **only on first volume init**.
  After a schema change: `docker compose down -v && docker compose up --build`
  (this wipes data — fine pre-production).

## PDF export

Fully client-side (jsPDF) — the **Export PDF** button captures the live
MapLibre canvas exactly as shown (current centre/zoom/basemap + all rendered
features) and builds an A3-landscape PDF with a header and a grouped feature
list. No server/Puppeteer; the export always matches the on-screen view.

## Offline

- The Workbox service worker precaches the app shell and caches Mapbox tiles
  (StaleWhileRevalidate, ~100 tiles/zoom) plus API GETs.
- Mutations made offline are queued in IndexedDB (Dexie) and replayed
  oldest-first on reconnect. Conflict policy: server-wins (logged).
- An online/offline badge with the pending-mutation count is in the header;
  manual sync + queue controls live in **Settings**.

## Deployment notes

- The `web` container runs the Vite **dev** server for this first pass. For
  production, build the SPA (`npm run build` in `web`) and serve the static
  `dist/` from nginx; point nginx `location /` at the built assets instead of
  `web:5173`, and keep `/api/` proxied to the api service.
- Put real Postgres credentials in `.env`; never commit `.env`.
- Persist the `db_data` and `photo_data` volumes (or back them up).
- Terminate TLS at nginx (or an upstream LB) in production — the service
  worker and geolocation require a secure context off `localhost`.

## Repo layout

See the tree in the project brief. Key entrypoints: `api/src/index.ts`,
`web/src/main.tsx`, `db/init/02_schema.sql`, `nginx/nginx.conf`.
