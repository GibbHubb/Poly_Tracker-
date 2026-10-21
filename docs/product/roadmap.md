# Roadmap

> Now / Next / Later. Not dates — sequence and intent. Revisit when scope changes.
> The live ticket list is the `PT*` rows in `backlog_bandit/BACKLOG.md`; this page is the summary.

## Now

- **PT38** a photo whose upload reply was lost is not stored twice (built; needs migration 004 on
  production before the push).
- **PT42** refuse paddocks that cross themselves; one fixture file for client and server rules
  (built).
- **PT27** a sweep that reclaims photo objects no row claims (built).
- **PT37** this documentation pass.

## Next

- **PT34** the mobile layout pass: bottom-sheet list, folded layers, ≥ 44 px controls (coded on a
  branch, needs the layout walk at seven widths).
- **PT33** user accounts and per-farm access, replacing the deployment-wide token (paused at the
  data migration, which needs a go on its numbers).

## Later

- An OpenAPI spec generated from the Zod schemas, replacing the hand-written `api.md`.
- Sharing a read-only farm map by link.
- Scheduling the photo sweep once uploads actually fail in the field.

## Done

Newest first (dates are when each closed):

- 2026-10-08 · PT36 the web suite runs in CI with a coverage floor · PT41 degenerate geometry refused
- 2026-10-02 · PT35 failures are visible and honest · PT29 the map keeps your farm offline
- 2026-10-01 · PT40 a refused save says so, wherever you are
- 2026-09-22 · PT24 photos in a private Supabase bucket
- 2026-09-17 · PT28 a photo taken with no signal is kept and uploaded later
- 2026-09-17 · PT26 a real phone photo reaches the API: shrunk, EXIF-free, location kept
- 2026-09-01 · PT25 no Mapbox token means Esri imagery, not a grey map
- 2026-08-31 · PT21 live on Vercel, reproducible from the repo
- 2026-08-19 · PT23 writes refused in production without a configured token
- 2026-08-18 · PT22 the database moved to Supabase after Render deleted it
- 2026-08-06 · PT16 self-hosted glyphs so labels work offline
- 2026-07-07 · PT19 bulk GeoJSON import in one transaction
- 2026-06-09 · PT15 conflict-resolution UI
- 2026-05-20 · PT5d production nginx build
