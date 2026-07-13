import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    pool: 'forks',
    // The integration tests all share ONE Postgres DB and TRUNCATE the tables
    // between cases, so test files MUST run one-at-a-time. Running them in
    // parallel deadlocks on the shared tables (concurrent TRUNCATE vs. FK
    // row-locks) and lets one file's TRUNCATE wipe another file's fixtures
    // mid-test (→ farm_id FK violations → 500s). Vitest 4 removed the old
    // `poolOptions.forks.singleFork` that used to enforce serialization, so we
    // pin it explicitly with the stable top-level `fileParallelism: false`.
    fileParallelism: false,
    globalSetup: './test/globalSetup.ts',
  },
});
