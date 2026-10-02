// PT32 — fail the build when any emitted script is over budget.
//
// Run after `vite build`. Sizes are raw (minified, uncompressed) bytes, the
// same figure vite prints in its chunk table, in vite's kB (1,000 bytes).
// The largest chunk today is MapLibre's CSP build at ~693 kB; anything that
// pushes a chunk past 700 kB has to be split or justified, not waved through.
// The margin is thin (~7 kB) on purpose: a MapLibre bump that grows it is a
// decision to make, not something to discover in production. Scope is
// dist/assets/*.js (every chunk and the MapLibre worker); dist/sw.js (~25 kB)
// is outside it.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUDGET_KB = Number(process.env.BUNDLE_BUDGET_KB ?? 700);
const dir = fileURLToPath(new URL('../dist/assets/', import.meta.url));

let files;
try {
  files = readdirSync(dir).filter((f) => f.endsWith('.js'));
} catch {
  console.error('check-bundle-budget: dist/assets not found — run `npm run build` first.');
  process.exit(2);
}
if (files.length === 0) {
  console.error('check-bundle-budget: no scripts in dist/assets — refusing to pass an empty build.');
  process.exit(2);
}

const rows = files
  .map((f) => ({ f, kb: statSync(join(dir, f)).size / 1000 }))
  .sort((a, b) => b.kb - a.kb);
const over = rows.filter((r) => r.kb > BUDGET_KB);
for (const r of rows) {
  console.log(`${r.kb > BUDGET_KB ? 'OVER' : '  ok'}  ${r.kb.toFixed(2).padStart(9)} kB  ${r.f}`);
}
if (over.length) {
  console.error(`\ncheck-bundle-budget: ${over.length} script(s) over the ${BUDGET_KB} kB budget.`);
  process.exit(1);
}
console.log(`\ncheck-bundle-budget: ${rows.length} scripts, largest ${rows[0].kb.toFixed(2)} kB, budget ${BUDGET_KB} kB.`);
