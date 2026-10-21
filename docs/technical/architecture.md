# Architecture

## System overview

Poly Tracker is a single-origin web app. A React PWA lets someone on a cattle station draw paddocks,
poly pipe runs and point features (troughs, bores, gates…) on satellite imagery, attach photos, and
keep working with no signal; an Express API stores everything in PostgreSQL + PostGIS. In
production one Vercel project serves both: the built SPA as static files and the Express app as one
serverless function under `/api/*`, against a `poly` schema in a shared Supabase project. Locally,
docker-compose runs the same code as four containers.

## Diagram

```
 phone / laptop browser
 ┌──────────────────────────────────────────────┐
 │ React SPA (Vite build)                        │
 │  pages: FarmList · FarmMap · Settings         │
 │  MapLibre GL v3 + mapbox-gl-draw              │
 │  Zustand store                                │
 │  Dexie (IndexedDB): pending edits, photo      │──── offline: edits + photos queue here,
 │    queue, conflicts                           │     replayed oldest-first on reconnect
 │  Workbox service worker: app shell, tiles,    │
 │    API GETs                                   │
 └──────────────┬───────────────────────────────┘
                │ same origin  /api/*   (Bearer token on writes)
 ┌──────────────▼───────────────────────────────┐        ┌───────────────────────────┐
 │ Express app  (api/src/index.ts)               │        │ Mapbox / Esri imagery      │
 │  requestId → accessLog → requireToken         │        │ (fetched by the browser)   │
 │  routes: farms, paddocks, poly-runs,          │        └───────────────────────────┘
 │    features, photos, import · errorHandler    │
 │  photo store: disk | Supabase Storage         │─────── Supabase Storage bucket (private)
 └──────────────┬───────────────────────────────┘
                │ pg (pool of 1 on Vercel), role poly_app
 ┌──────────────▼───────────────────────────────┐
 │ Postgres 16 + PostGIS 3  — schema `poly`      │
 └──────────────────────────────────────────────┘
```

## Components

| Component | Responsibility | Tech |
|-----------|-----------------|------|
| `web/` SPA | farm list, the map editor, settings; drawing, validation before save (`lib/geometryCheck.ts`), PDF export | React 18, Vite, TypeScript, MapLibre GL v3 (pinned: v4 breaks mapbox-gl-draw), mapbox-gl-draw + a circle mode, Tailwind, Zustand, React Router |
| Offline layer | queue writes and photos while offline, replay them, detect and merge conflicts | Dexie (IndexedDB) in `lib/db.ts`, `lib/sync.ts`, `lib/photoQueue.ts`, `lib/conflictMerge.ts` |
| Service worker | precache the app shell; cache map tiles and API GETs | Workbox (`web/src/sw.ts`, vite-plugin-pwa) |
| PDF export | A3 landscape map + feature list from the live canvas | jsPDF, client-side only (no server rendering) |
| `api/` | the REST API in [`api.md`](api.md); validation, token gate, error handling, structured logs | Node 20, Express, TypeScript, Zod, node-postgres, Multer |
| Photo store | where photo bytes live | `api/src/storage/`: `disk` (self-hosted) or `supabase` (Vercel) |
| Database | farms, paddocks, poly runs, features, photos; see [`data-model.md`](data-model.md) | PostgreSQL 16 + PostGIS, SRID 4326 |

## Key flows

**Draw and save.** The user draws on the map; mapbox-gl-draw yields GeoJSON. The SPA wraps
longitudes from panned-onto world copies back into range and checks the shape
(`geometryProblem`); a bad shape gets a notice and never reaches the name dialog. On save it POSTs
the Feature to the matching route; the API validates the same rules (Zod) and inserts with
`ST_GeomFromGeoJSON`. The response carries an `ETag` with the row's version.

**Offline edit and replay.** A write that cannot reach the API is stored in Dexie's `pending` table
with the version it was made on. On reconnect `replayQueue` sends them oldest-first with
`If-Match: "<version>"`. A 412 means someone else changed the row: the edit goes to `conflicts` and
the field-level merge UI (PT18) offers the choice. Refused rows (4xx) are set aside so they stop
blocking the queue (PT35).

**Photo.** The browser reads GPS/time from EXIF, downscales to ~1600 px (Vercel refuses bodies over
~4.5 MB) and POSTs it with a `client_id` made before the first attempt. Offline, it goes to Dexie's
`photoQueue` under that same id. The API stores the bytes first, then the row; a repeat of a known
`client_id` returns the existing row (PT38). Orphaned objects are reclaimed by
`api/scripts/sweep-photos.ts` (PT27).

## Cross-cutting concerns

- **Auth:** a two-tier bearer-token gate (`requireToken`), no user accounts; production refuses
  writes when no write token is configured (PT23). User accounts and per-farm authorization are
  PT33.
- **Validation:** Zod on every body and on `?bbox=`; geometry rules shared with the client through
  `fixtures/geometry-cases.json`.
- **Errors:** our own messages are returned; anything unanticipated becomes a generic 500 with a
  request id, the detail goes to the log only (PT35). See [`api.md`](api.md#errors).
- **Logging / observability:** one JSON line per request (`accessLog`) and per error (`log()`),
  keyed by `x-request-id`; `/api/health` reports DB reachability and this instance's recent error
  counts.
- **Config / secrets:** environment variables only (`.env` locally, Vercel project settings in
  production). The migration DSN (`POLY_TRACKER_MIGRATION_URL`) is never in the app's runtime env.
- **Concurrency:** optimistic, via the `version` column + `ETag` / `If-Match`.

## Deployment topology

| Environment | Where | How it gets there |
|---|---|---|
| Production | Vercel project `poly-tracker` (https://poly-tracker-ashy.vercel.app): SPA static + `api/src/vercel.ts` function, region `dub1` | push to `main` (git-triggered build, `vercel.json`) |
| Database | Supabase project, schema `poly`, role `poly_app`; photos in a private Storage bucket | migrations by hand: `cd api && npm run db:init` with `POLY_TRACKER_MIGRATION_URL` |
| Local development | `docker compose up --build`: `db` (PostGIS), `api` (tsx watch), `web` (Vite), `nginx` on :8080 | the working tree, bind-mounted |
| CI | GitHub Actions `ci.yml`: web typecheck/build/tests + coverage floor + bundle budget, API typecheck/build/tests against a PostGIS service | every push / PR |

Details and the load-bearing connection-string rules: [`DEPLOY.md`](../../DEPLOY.md).
