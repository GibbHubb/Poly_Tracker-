#!/usr/bin/env node
// PT33 — backfill farm_members: every farm that has NO member yet gets one
// owner (Max), so switching AUTH_USERS=on does not make every existing farm
// invisible to everyone.
//
// This is a mass write of a decision-shaped field (who owns what), so it is
// gated:
//   1. Dry run (the default). Opens a READ ONLY transaction and prints the
//      counts it WOULD insert. Writes nothing; works before 005 is applied.
//        cd api
//        DATABASE_URL="postgres://…" PGSSL=true node scripts/backfill-farm-members.mjs
//   2. Max reads the numbers and says go.
//   3. Apply, repeating the number he approved. Refuses if reality moved.
//        node scripts/backfill-farm-members.mjs --apply --owner <auth.users uuid> --expect <n>
//
// Idempotent: ON CONFLICT DO NOTHING, and only farms with zero members count.
import pg from 'pg';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const apply = args.includes('--apply');
const owner = flag('--owner');
const expect = flag('--expect');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const url = process.env.POLY_TRACKER_MIGRATION_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL (dry run) or POLY_TRACKER_MIGRATION_URL.');
  process.exit(1);
}
if (apply && (!owner || !UUID.test(owner))) {
  console.error('--apply needs --owner <auth.users uuid>.');
  process.exit(1);
}
if (apply && (expect === undefined || !/^\d+$/.test(expect))) {
  console.error('--apply needs --expect <n>: the farm count from the dry run that was approved.');
  process.exit(1);
}

const useSsl = process.env.PGSSL === 'true' || /sslmode=require/.test(url);
const client = new pg.Client({
  connectionString: url,
  ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
});

await client.connect();
try {
  await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
  const { rows: where } = await client.query(
    "SELECT current_database() AS db, current_user AS role, current_schema() AS schema, to_regclass('farm_members') IS NOT NULL AS has_table, to_regclass('farms') IS NOT NULL AS has_farms",
  );
  const w = where[0];
  console.log(`→ database=${w.db} role=${w.role} schema=${w.schema} (${apply ? 'APPLY' : 'DRY RUN, read-only'})`);
  if (!w.has_farms) throw new Error('no farms table on this search_path — wrong database or role?');

  const { rows: t } = await client.query('SELECT count(*)::int AS n FROM farms');
  let unowned;
  let existing = 0;
  if (w.has_table) {
    const { rows } = await client.query(
      'SELECT count(*)::int AS n FROM farms f WHERE NOT EXISTS (SELECT 1 FROM farm_members m WHERE m.farm_id = f.id)',
    );
    unowned = rows[0].n;
    const { rows: m } = await client.query('SELECT count(*)::int AS n FROM farm_members');
    existing = m[0].n;
  } else {
    unowned = t[0].n; // 005 not applied yet: every farm would need an owner
  }
  console.log(`  farms total:                 ${t[0].n}`);
  console.log(`  farm_members table present:  ${w.has_table ? 'yes' : 'NO (apply 005 first)'}`);
  console.log(`  farm_members rows now:       ${existing}`);
  console.log(`  farms with no member:        ${unowned}`);
  console.log(`  rows the backfill would add: ${unowned} (role 'owner', user ${owner ?? '<--owner>'})`);

  if (!apply) {
    await client.query('ROLLBACK');
    console.log('Dry run: nothing written.');
  } else {
    if (!w.has_table) throw new Error('farm_members does not exist: run `npm run db:init` (applies 005) first.');
    if (Number(expect) !== unowned) {
      throw new Error(`refusing: approved ${expect} but ${unowned} farms are unowned now. Dry-run again.`);
    }
    const { rowCount } = await client.query(
      `INSERT INTO farm_members (farm_id, user_id, role)
       SELECT f.id, $1, 'owner' FROM farms f
        WHERE NOT EXISTS (SELECT 1 FROM farm_members m WHERE m.farm_id = f.id)
       ON CONFLICT (farm_id, user_id) DO NOTHING`,
      [owner],
    );
    if (rowCount !== unowned) throw new Error(`inserted ${rowCount}, expected ${unowned}; rolled back.`);
    await client.query('COMMIT');
    console.log(`✓ inserted ${rowCount} owner rows.`);
  }
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(`✗ ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
