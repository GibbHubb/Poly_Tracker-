# MVP scope

## Goal of the MVP

One station's water infrastructure is mapped on a phone, survives a day with no signal, and can be
handed to someone else as a map they can follow.

## In scope

- Create a farm and open it on satellite imagery (Mapbox, or Esri with no token).
- Draw paddocks (polygons, including a circle tool), poly runs (lines) and point features of seven
  types; name, colour, annotate, edit and delete them.
- Poly-run attributes: diameter, depth, material, install date.
- Take or attach photos on a point feature, with the location and time kept.
- Keep working offline: edits and photos queue on the device and replay on reconnect; map tiles
  for an area can be saved for offline use.
- See and resolve a conflict when someone else changed the same thing.
- Export an A3 PDF of the current map view with a feature list.
- Import and export the farm as GeoJSON.

## Out of scope (explicit non-goals)

- **User accounts, sharing and per-farm permissions.** The MVP is protected by a deployment-wide
  write token; accounts are PT33, after the MVP, because they are a schema and auth change of their
  own.
- Native apps: a PWA covers install-to-home-screen and offline.
- Hydraulic calculations, flow or pressure modelling.
- Survey-grade accuracy or coordinate systems other than WGS 84.
- Paid map layers or any feature that costs money to run.

## Deferred to post-MVP

See [roadmap.md](roadmap.md): user accounts (PT33), the mobile layout pass (PT34), and the
follow-ups filed by reviews.

## Acceptance

- The draw → save → reload round trip works against production for all three geometry kinds.
- With the phone offline, an edit and a photo are queued, and both reach the server after
  reconnecting (proven in the browser for PT28/PT29).
- A write with a stale version shows the conflict UI rather than overwriting.
- A degenerate shape (two points, a line of corners, a bow-tie) is refused before saving, on the
  client and the server alike.
- The PDF export matches what is on screen.
