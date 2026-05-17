import Dexie, { type Table } from 'dexie';

export type MutationOp = 'create' | 'update' | 'delete';

export interface PendingMutation {
  id: string; // client-generated uuid
  op: MutationOp;
  endpoint: string; // path relative to API base, e.g. /farms/<id>/features
  method: 'POST' | 'PATCH' | 'DELETE';
  payload: unknown;
  createdAt: number;
}

export interface CachedFarm {
  id: string;
  name: string;
  owner: string | null;
  created_at: string;
}

class PolyTrackerDB extends Dexie {
  pending!: Table<PendingMutation, string>;
  farms!: Table<CachedFarm, string>;

  constructor() {
    super('poly_tracker');
    this.version(1).stores({
      pending: 'id, createdAt',
      farms: 'id',
    });
  }
}

export const db = new PolyTrackerDB();

export async function queueMutation(
  m: Omit<PendingMutation, 'createdAt'>,
): Promise<void> {
  await db.pending.put({ ...m, createdAt: Date.now() });
}

export async function pendingCount(): Promise<number> {
  return db.pending.count();
}
