import type { Request, Response } from 'express';
import { query } from '../db.js';
import { HttpError } from '../middleware/index.js';

/**
 * PT18-fu1 — optimistic concurrency helpers.
 *
 * Every UPDATE used to be last-write-wins, so the API never returned 409/412.
 * PT15's replay machinery and PT18's field-level merge both only trigger on
 * one of those, which meant conflicts were never logged organically and the
 * merge UI could not be reached without hand-seeding a `db.conflicts` row.
 *
 * The mechanism is a monotonic integer `version` on the row, surfaced as a
 * weak-free ETag. A client that read version 3 sends `If-Match: "3"`; if the
 * row has since moved to 4 the UPDATE matches nothing and we answer 412.
 *
 * Opt-in by design: a request with no `If-Match` keeps the old last-write-wins
 * behaviour. Existing clients (and the importer) therefore do not break, and
 * the offline replay path can adopt it independently.
 */

/**
 * Read `If-Match` as a version number.
 *
 * Accepts `"3"`, `3`, and `W/"3"`. Returns null when the header is absent
 * (meaning "no precondition"). `*` also returns null — it asserts only that
 * the resource exists, which the UPDATE's own 404 already covers.
 *
 * Throws 400 on a malformed value rather than silently ignoring it: quietly
 * dropping a precondition the client believed it set is the one failure mode
 * this feature must not have.
 */
export function parseIfMatch(req: Request): number | null {
  const raw = req.headers['if-match'];
  if (raw === undefined) return null;
  const header = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = header.trim();
  if (trimmed === '' || trimmed === '*') return null;

  const unquoted = trimmed.replace(/^W\//i, '').replace(/^"|"$/g, '');
  if (!/^\d+$/.test(unquoted)) {
    throw new HttpError(400, `Malformed If-Match header: ${header}`);
  }
  return Number(unquoted);
}

/** Set the ETag for a row so the client can capture its base version. */
export function setVersionETag(res: Response, version: number | undefined): void {
  if (typeof version === 'number') res.setHeader('ETag', `"${version}"`);
}

/**
 * Called when a versioned UPDATE matched no rows. Distinguishes the two
 * reasons — the row is gone (404) or someone else moved it on (412) — because
 * the client's response to each is completely different: drop the change, or
 * merge against the newer version.
 *
 * The 412 body carries the current version so the client can re-read and
 * merge without a second round trip.
 */
export async function throwUpdateConflict(
  table: 'farms' | 'paddocks' | 'features' | 'poly_runs',
  // Express types route params as `string | string[]`; a path segment is
  // always singular in practice, so normalise here rather than casting at
  // every call site.
  id: string | string[] | undefined,
  expectedVersion: number,
  notFoundMessage: string,
  // PT33 — for a farm's child record, the farm in the URL. Without it a caller
  // allowed on farm A could PATCH /farms/A/paddocks/<B's paddock id> with an
  // If-Match and read B's row version (and its existence) out of the 412.
  farmId?: string | string[],
): Promise<never> {
  const rowId = Array.isArray(id) ? id[0] : id;
  if (rowId === undefined) throw new HttpError(404, notFoundMessage);
  const farm = Array.isArray(farmId) ? farmId[0] : farmId;
  const { rows } = await query<{ version: number }>(
    farm !== undefined
      ? `SELECT version FROM ${table} WHERE id = $1 AND farm_id = $2`
      : `SELECT version FROM ${table} WHERE id = $1`,
    farm !== undefined ? [rowId, farm] : [rowId],
  );
  if (rows.length === 0) throw new HttpError(404, notFoundMessage);

  const current = rows[0]!.version;
  const err = new HttpError(
    412,
    `Precondition failed: expected version ${expectedVersion}, current is ${current}`,
  ) as HttpError & { currentVersion: number };
  err.currentVersion = current;
  throw err;
}
