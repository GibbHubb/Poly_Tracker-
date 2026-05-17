# Poly Tracker — Task Backlog

Tasks are PT-prefixed. This batch covers the gaps left by the first scaffold
pass (CRUD-create + list works; editing, rendering existing geometry, and
photo intelligence do not yet).

---

## PT-1 — Render existing geometry on the interactive map

**Why:** `MapView` only hosts the draw toolbar; saved paddocks/poly-runs/
features are listed in the sidebar but never drawn on the live map (they only
appear in the print route). Users can't see what already exists in the paddock.

**Scope:**
- Add GeoJSON sources + styled layers to `MapView` for paddocks, poly runs,
  and points, fed from `FarmMap` state.
- Wire `useAppStore.visibleLayers` to layer `visibility`.
- Fit map bounds to existing features on load (reuse the bounds logic from
  `PrintFarm`).
**Done when:** reloading a farm shows all saved geometry on the satellite map,
and the LayerToggle hides/shows each collection.

## PT-2 — Photo upload with EXIF GPS extraction

**Why:** `PhotoUpload` forwards no real location; `photos.lat/lng` stay null.
Field photos must self-locate.

**Scope:**
- Parse EXIF GPS from the uploaded image (client-side, lightweight — e.g.
  `exifr`) and send `lat`/`lng`/`taken_at`.
- Fall back to `navigator.geolocation` when EXIF has no GPS.
- Show a thumbnail + captured coordinates after upload.
**Done when:** a geotagged photo lands in the DB with correct lat/lng and
renders as a marker source on the map.

## PT-3 — Feature edit & delete UI

**Why:** API supports PATCH/DELETE for all collections; the UI has no way to
rename, retype, edit attributes (diameter, depth, material, installed_date),
or delete. Drawn items are stuck with placeholder names.

**Scope:**
- Selecting a sidebar/map feature opens an editable detail panel
  (Tailwind + headlessui dialog if needed).
- PATCH on save, DELETE with confirm; optimistic update + offline queue
  (`queueMutation` with method `PATCH`/`DELETE`).
**Done when:** every attribute in the schema is editable from the UI and
changes survive a reload.

## PT-4 — Offline geometry editing parity

**Why:** Only `create` is queued offline; PATCH/DELETE made offline are lost.
`sync.ts` replays generically but nothing enqueues edits.

**Scope:**
- Route all mutating API calls through a single helper that tries the network
  then falls back to `queueMutation`.
- Add a conflict log view in Settings (the `conflicts` array from
  `replayQueue` is currently discarded).
**Done when:** creating, editing, and deleting fully offline then reconnecting
reconciles the server with server-wins, and conflicts are visible.

## PT-5 — Production web build served by nginx

**Why:** `web` runs the Vite dev server; nginx proxies to it. Not deployable.

**Scope:**
- Multi-stage `web/Dockerfile`: `npm run build` → static `dist/` served by
  the nginx container (or an nginx stage).
- Update `nginx.conf` to serve built assets for `/` with SPA fallback, keep
  `/api/` proxied, and ensure the service worker + correct MIME for `sw.js`.
- Document the dev-vs-prod compose override.
**Done when:** `docker compose -f docker-compose.yml -f docker-compose.prod.yml
up` serves the built PWA with a working service worker and PDF export.

---

### Later / unscoped
- AuthN/AuthZ (no auth today — anyone can CRUD any farm).
- Automated tests (API integration + a Playwright PDF smoke test).
- Photo serving endpoint + gallery (uploads are stored but never served back).
- Per-farm tile pre-download for true paddock offline use.
