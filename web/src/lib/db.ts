import Dexie, { type Table } from 'dexie';

export type MutationOp = 'create' | 'update' | 'delete';

export interface PendingMutation {
  id: string; // client-generated uuid
  op: MutationOp;
  endpoint: string; // path relative to API base, e.g. /farms/<id>/features
  method: 'POST' | 'PATCH' | 'DELETE';
  payload: unknown;
  createdAt: number;
  // PT18-fu2 — row version at the time the edit was made, replayed as
  // If-Match. Undefined/null means "no precondition", which is what
  // poly-runs and creates want. Not indexed, so no Dexie schema bump.
  baseVersion?: number | null;
}

export interface CachedFarm {
  id: string;
  name: string;
  owner: string | null;
  created_at: string;
}

/** A pre-downloaded offline tile area (PT11) — manifest only; the tile bytes
 *  live in the 'offline-tiles' Cache Storage cache, not here. */
export interface OfflineArea {
  id: string;
  name: string;
  provider: string;
  bounds: [number, number, number, number]; // [w, s, e, n]
  zMin: number;
  zMax: number;
  tileCount: number;
  bytes: number;
  createdAt: number;
}

/** A mutation the server rejected as a conflict during replay (server-wins). */
export interface ConflictRecord {
  id: string; // original mutation id
  op: MutationOp;
  endpoint: string;
  method: 'POST' | 'PATCH' | 'DELETE';
  status: number;
  resolvedAt: number;
  payload?: unknown; // added in PT15; undefined on pre-PT15 records
}

/**
 * PT28 — a photo taken with no signal, held on the device until it can upload.
 * The Blob itself lives in IndexedDB (stored natively, no base64). Location and
 * time are captured at QUEUE time: a photo of a trough uploaded at the homestead
 * must still say where the trough is.
 */
export interface QueuedPhoto {
  id: string;
  blob: Blob;
  filename: string;
  featureType?: string;
  featureId: string;
  lat: number | null;
  lng: number | null;
  takenAt: string;
  createdAt: number;
  /** 'queued' is retried; 'failed' was refused by the server (4xx) and is kept for the user. */
  status: 'queued' | 'failed';
  lastError?: string;
  /** Consecutive 5xx answers; see MAX_SERVER_ERRORS in photoQueue.ts. */
  serverErrors?: number;
}

class PolyTrackerDB extends Dexie {
  pending!: Table<PendingMutation, string>;
  photoQueue!: Table<QueuedPhoto, string>;
  farms!: Table<CachedFarm, string>;
  conflicts!: Table<ConflictRecord, string>;
  offlineAreas!: Table<OfflineArea, string>;

  constructor() {
    super('poly_tracker');
    this.version(1).stores({
      pending: 'id, createdAt',
      farms: 'id',
    });
    this.version(2).stores({
      pending: 'id, createdAt',
      farms: 'id',
      conflicts: 'id, resolvedAt',
    });
    // v3 (PT11): offline tile-area manifest. Additive — older clients ignore it.
    this.version(3).stores({
      pending: 'id, createdAt',
      farms: 'id',
      conflicts: 'id, resolvedAt',
      offlineAreas: 'id, createdAt',
    });
    // v4 (PT15): ConflictRecord gains `payload` field. Indexes unchanged — additive.
    this.version(4).stores({
      pending: 'id, createdAt',
      farms: 'id',
      conflicts: 'id, resolvedAt',
      offlineAreas: 'id, createdAt',
    });
    // v5 (PT28): photos queued offline. Additive — an older bundle ignores the table.
    this.version(5).stores({
      pending: 'id, createdAt',
      farms: 'id',
      conflicts: 'id, resolvedAt',
      offlineAreas: 'id, createdAt',
      photoQueue: 'id, createdAt, status, featureId',
    });
  }
}

export const db = new PolyTrackerDB();

export async function queueMutation(
  m: Omit<PendingMutation, 'createdAt'>,
): Promise<void> {
  await db.pending.put({ ...m, createdAt: Date.now() });
}

/** Everything still waiting to reach the server: JSON edits plus queued photos (PT28). */
export async function pendingCount(): Promise<number> {
  const [edits, photos] = await Promise.all([
    db.pending.count(),
    db.photoQueue.where('status').equals('queued').count(),
  ]);
  return edits + photos;
}
