# API

Written from `api/src/index.ts`, `api/src/middleware/index.ts` and `api/src/routes/*.ts`
(2026-10-21, PT37). Every route the app mounts is listed below; if you add one, add it here.

## Conventions

- **Base URL:** `/api` on the same origin as the web app (production:
  `https://poly-tracker-ashy.vercel.app/api`; local docker-compose: `http://localhost:8080/api`,
  or the api container directly on `:3001`). No versioning in the path.
- **Content type:** JSON (`application/json`, body limit 5 MB) except the two upload routes, which
  take `multipart/form-data`.
- **Geometry:** GeoJSON, SRID 4326 (`[longitude, latitude]`). Map objects are returned as a GeoJSON
  `Feature`, lists as a `FeatureCollection`; the row's columns are the `properties`.
- **Request id:** every response carries `x-request-id`; error bodies repeat it as `requestId` where
  it helps find the log line.

## Authentication

There are no user accounts yet (planned: PT33). Access is a **bearer-token gate with two tiers**
(`requireToken`, applied to every route except `/api/health`):

| Configured on the server | Reads (GET/HEAD/OPTIONS) | Writes (POST/PATCH/PUT/DELETE) |
|---|---|---|
| nothing, `NODE_ENV` ≠ production | open | open (local dev and tests only) |
| nothing, `NODE_ENV=production` | open | **503** `Writes are disabled: API_WRITE_TOKEN is not configured…` (PT23, fails closed) |
| `API_WRITE_TOKEN` (or legacy `API_TOKEN`) | open | need `Authorization: Bearer <write token>`, else **401** |
| `API_READ_TOKEN` too | need the read **or** write token, else **401** | as above |

The comparison is constant-time. Tokens do not expire; changing the env var is the only way to
revoke one.

## Errors

Body shape: `{ "error": "<sentence>" }`, plus fields named below.

| Status | When | Body |
|---|---|---|
| 400 | Zod validation failed | `{ "error": "ValidationError", "issues": [ … ] }` (zod issue list: path + message) |
| 400 | malformed JSON / `If-Match` / missing upload field | `{ "error": "…", "requestId"? }` |
| 400 | a malformed id, e.g. `/api/farms/not-a-uuid` (Postgres 22P02) | `{ "error": "Malformed identifier or value.", "requestId" }` |
| 401 | missing or wrong bearer token | `{ "error": "Unauthorized" }` |
| 404 | the row (or its farm) does not exist | `{ "error": "Farm not found" }` etc. |
| 404 | a write points at a farm/feature that is gone (Postgres 23503) | `{ "error": "The farm or record this refers to does not exist…", "requestId" }` |
| 412 | `If-Match` version is stale | `{ "error": "Precondition failed: expected version 3, current is 4" }` |
| 413 | body over 5 MB, or a photo over 4 MB | `{ "error": "…" }` |
| 422 | GeoJSON import, all-or-nothing, one feature refused | the import report, see below |
| 500 | anything unanticipated | `{ "error": "Something went wrong on the server. Quote the request id if you report it.", "requestId" }`; the detail is in the log only (PT35) |
| 503 | writes disabled (above), photo storage unusable, or the database is down (`/api/health`) | `{ "error": "…" }` |

**Optimistic concurrency (412).** Single-object GETs, creates and updates return
`ETag: "<version>"`. A PATCH may send `If-Match: "<version>"` (`W/"3"` and bare `3` are accepted;
anything else is a 400). If the row has moved on, the PATCH changes nothing and answers 412. No
`If-Match` means last-write-wins, which is what the importer and older clients do.

## Pagination, filtering, sorting

No pagination. Lists are ordered by `created_at` (farms newest first, map objects oldest first).
The three map-object lists take an optional `?bbox=west,south,east,north` (four finite numbers,
west < east, south < north; anything else is a 400) and then return only objects intersecting that
envelope (PT31). Photo lists filter by `?feature_id=` or `?farm_id=`.

## Endpoints

`:farmId`, `:id` etc. are uuids. "Auth" is the tier from the table above: **R** = read tier,
**W** = write tier, **–** = none.

| Method | Path | Purpose | Auth | Success | Other statuses |
|--------|------|---------|------|---------|----------------|
| GET | `/api/health` | DB round-trip + error counters for this instance | – | 200 `{ ok, db: "up", … }` | 503 `{ ok: false, db: "down" }` |
| GET | `/api/farms` | list farms | R | 200 array | 401 |
| GET | `/api/farms/:id` | one farm (+ ETag) | R | 200 | 401, 404 |
| POST | `/api/farms` | create `{ name, owner? }` | W | 201 (+ ETag) | 400, 401, 503 |
| PATCH | `/api/farms/:id` | update `{ name?, owner? }` | W | 200 (+ ETag) | 400, 401, 404, 412, 503 |
| DELETE | `/api/farms/:id` | delete; cascades paddocks, poly runs, features | W | 204 | 401, 404, 503 |
| GET | `/api/farms/:farmId/paddocks` | list (`?bbox=`) | R | 200 FeatureCollection | 400, 401 |
| GET | `/api/farms/:farmId/paddocks/:id` | one paddock | R | 200 Feature | 401, 404 |
| POST | `/api/farms/:farmId/paddocks` | create: Polygon + `{ name, color?, notes? }` | W | 201 Feature | 400, 401, 503 |
| PATCH | `/api/farms/:farmId/paddocks/:id` | replace properties, geometry optional | W | 200 Feature | 400, 401, 404, 412, 503 |
| DELETE | `/api/farms/:farmId/paddocks/:id` | delete | W | 204 | 401, 404, 503 |
| GET | `/api/farms/:farmId/poly-runs` | list (`?bbox=`) | R | 200 FeatureCollection | 400, 401 |
| GET | `/api/farms/:farmId/poly-runs/:id` | one poly run | R | 200 Feature | 401, 404 |
| POST | `/api/farms/:farmId/poly-runs` | create: LineString + `{ name, diameter_mm?, depth_m?, material?, installed_date?, color?, notes? }` | W | 201 Feature | 400, 401, 503 |
| PATCH | `/api/farms/:farmId/poly-runs/:id` | replace properties, geometry optional | W | 200 Feature | 400, 401, 404, 412, 503 |
| DELETE | `/api/farms/:farmId/poly-runs/:id` | delete | W | 204 | 401, 404, 503 |
| GET | `/api/farms/:farmId/features` | list points (`?bbox=`) | R | 200 FeatureCollection | 400, 401 |
| GET | `/api/farms/:farmId/features/:id` | one point | R | 200 Feature | 401, 404 |
| POST | `/api/farms/:farmId/features` | create: Point + `{ type, name?, color?, notes? }` | W | 201 Feature | 400, 401, 503 |
| PATCH | `/api/farms/:farmId/features/:id` | replace properties, geometry optional | W | 200 Feature | 400, 401, 404, 412, 503 |
| DELETE | `/api/farms/:farmId/features/:id` | delete | W | 204 | 401, 404, 503 |
| GET | `/api/photos` | list (`?feature_id=` or `?farm_id=`, else all) | R | 200 array | 401 |
| GET | `/api/photos/file/:id` | the image: 302 to a 60 s signed URL (`supabase`) or the file (`disk`) | R | 302 / 200 | 401, 404 |
| POST | `/api/photos` | upload: `photo` file + `feature_type?`, `feature_id?`, `taken_at?`, `lat?`, `lng?`, `client_id?` | W | 201 row; **200** with the existing row when `client_id` was already stored (PT38) | 400, 401, 413, 503 |
| DELETE | `/api/photos/:id` | delete the row, then the stored object | W | 204 | 401, 404, 503 |
| POST | `/api/import/geojson` | bulk import into a farm: `file` (FeatureCollection) + `farm_id`; `?partial=true` | W | 200 report | 400, 401, 404, **422**, 503 |

**Feature types** (`features.type`): `trough`, `turkey_nest`, `bore`, `gate`, `tank`, `tap`, `other`.

**Geometry rules** (400 with a reason): a paddock ring is closed, has ≥ 3 different corners,
encloses an area and does not cross itself; a poly run has 2 different points; a point is within
−180..180 / −90..90. Each route takes only its own geometry type.

### GeoJSON import

Polygons become paddocks, LineStrings poly runs, Points features; anything else is reported as
`skipped`. Each feature is validated with its kind's schema and inserted under a SAVEPOINT inside
one transaction.

```json
{ "mode": "all-or-nothing", "committed": false, "inserted": 0, "skipped": 0, "errored": 1,
  "report": [ { "index": 3, "kind": "paddock", "status": "error",
                "error": "geometry.coordinates.0: a polygon outline must not cross itself" } ] }
```

Default **all-or-nothing**: the first refused feature rolls everything back and the answer is
**422** with that report. With `?partial=true` the valid features commit and the answer is 200 with
`"committed": true` and the failures listed. Database refusals are reported as
`rejected by the database (code <SQLSTATE>)`, never the database's own text.

### Examples

```bash
API=http://localhost:8080/api          # or the production origin
W="Authorization: Bearer $API_WRITE_TOKEN"

curl -s $API/health
curl -s -X POST $API/farms -H "$W" -H 'Content-Type: application/json' -d '{"name":"Home"}'
curl -s -X POST $API/farms/$FARM/paddocks -H "$W" -H 'Content-Type: application/json' \
  -d '{"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[150,-26],[150.01,-26],[150.01,-26.01],[150,-26.01],[150,-26]]]},"properties":{"name":"North"}}'
curl -s "$API/farms/$FARM/paddocks?bbox=149.9,-26.1,150.1,-25.9"
curl -s -X PATCH $API/farms/$FARM -H "$W" -H 'If-Match: "1"' -H 'Content-Type: application/json' -d '{"name":"Home 2"}'
curl -s -X POST $API/photos -H "$W" -F photo=@trough.jpg -F feature_id=$POINT -F client_id=$(uuidgen)
curl -s -X POST "$API/import/geojson?partial=true" -H "$W" -F file=@farm.geojson -F farm_id=$FARM
```
