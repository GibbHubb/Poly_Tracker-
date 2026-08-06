# Self-hosted map glyphs (PT16)

MapLibre needs glyph PBFs to render any `text-field`. The style used to point
at Mapbox's fonts endpoint, which is online-only — so map labels silently
disappeared offline while the rest of the PWA kept working. These files make
labels behave like everything else in the app.

## What's here

| Fontstack | Ranges | Why |
|---|---|---|
| `Open Sans Regular` | `0-255`, `256-511` | `text-font` in the paddock + feature label layers |
| `Open Sans Bold` | `0-255`, `256-511` | `text-font` in the farm label layer |

The fontstack directory names must match the `text-font` values in
`src/components/MapView.tsx` exactly — MapLibre substitutes them into
`{fontstack}` (URL-encoded, spaces become `%20`).

## Source and licence

[openmaptiles/fonts](https://github.com/openmaptiles/fonts) release **v2.0**.
Open Sans is licensed **Apache-2.0** (Steve Matteson / Google). The PBFs are
generated from the upstream TTFs with `fontnik`; this repo vendors the
prebuilt output rather than a build step.

## Why only two ranges

A full set is 256 ranges per weight, ~800 KB each — ~1.6 MB added to the
Workbox precache for both. Ranges `0-255` and `256-511` cover Basic Latin,
Latin-1 Supplement and Latin Extended-A, which is every character a farm,
paddock or feature name has realistically used, at ~296 KB total.

**If a name ever uses characters outside those blocks**, MapLibre will request
a range that isn't here, get a 404, and that label won't draw. Fix by copying
the extra range in:

```bash
# from a checkout of the openmaptiles/fonts v2.0 archive
cp "Open Sans Regular/512-767.pbf" "public/fonts/Open Sans Regular/"
```

`vite.config.ts` precaches `**/*.pbf`, so a new range is picked up by the next
build with no further wiring.
