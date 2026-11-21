/**
 * PT44 — the one name shape both backends' `put` produces:
 *
 *   `${randomUUID()}${ext || '.jpg'}`, with `ext` from the sniffed bytes in routes/photos.ts
 *
 * randomUUID() is a lowercase v4 UUID. Since PT43 `ext` is one of .jpg/.png/.webp/.heic/.heif
 * (lib/imageType.ts); before it was extname(originalname), '' or a single dot-led segment with
 * no further dot. Either way every name `put` wrote is `<v4 uuid>.<anything but a dot or a
 * slash>`, and older objects keep matching.
 *
 * `list()` returns ONLY names of this shape. The orphan sweep deletes what `list()` returns,
 * so anything else in the directory or bucket (a .gitkeep, `x.jpg.bak`, an operator's notes,
 * Supabase's .emptyFolderPlaceholder) must never reach it. If `put` ever changes its naming,
 * change this with it — the sweep tests put() real files and list them back.
 */
const PUT_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[^./\\]*$/;

export function isStoredObjectName(name: string): boolean {
  return PUT_NAME.test(name);
}
