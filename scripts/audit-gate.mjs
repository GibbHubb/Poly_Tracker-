#!/usr/bin/env node
// PT43 — dependency scanning gate for CI.
//
// Run from a package directory (api/ or web/):   node ../scripts/audit-gate.mjs
// or against a saved report:                     node ../scripts/audit-gate.mjs --report audit.json --scope web
// The scope (default: the current directory's name) picks the allowlist entries that apply.
//
// Fails (exit 1) on any HIGH or CRITICAL advisory that is not on the reviewed
// allowlist (scripts/audit-allowlist.json), and on any allowlist entry whose
// review-by date has passed while its advisory is still present. Moderate and
// low advisories are printed, not gated.
//
// Why not plain `npm audit --audit-level=high`: on the day this was added both
// packages had high/critical advisories whose ONLY fix is a breaking major
// (zod 3→4, maplibre-gl 3→6, jspdf 2→4, vitest 3→5). A step that is red from
// day one gets ignored or deleted. This one is green only because each of those
// was looked at and given a reason, a ticket and a date — and it goes red the
// moment a NEW high/critical appears, or a date passes.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';

const GATED = new Set(['high', 'critical']);

/** The GHSA id of an advisory, from its url (https://github.com/advisories/GHSA-…). */
export function ghsaOf(url) {
  const m = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i.exec(String(url ?? ''));
  return m ? m[0] : null;
}

/** Flatten `npm audit --json` (v2 format) into one row per (package, advisory). */
export function advisoriesOf(report) {
  const out = new Map();
  for (const [pkg, v] of Object.entries(report?.vulnerabilities ?? {})) {
    for (const via of v?.via ?? []) {
      // A string `via` points at another vulnerable package, which has its own entry.
      if (!via || typeof via !== 'object') continue;
      const id = ghsaOf(via.url) ?? `npm-${via.source}`;
      const key = `${pkg} ${id}`;
      if (!out.has(key)) {
        out.set(key, { package: pkg, id, severity: via.severity, title: via.title, url: via.url });
      }
    }
  }
  return [...out.values()];
}

/**
 * Decide. `today` is YYYY-MM-DD. Returns every advisory with its verdict:
 *   'blocked'  — gated severity, not allowlisted
 *   'expired'  — gated severity, allowlisted, but the review-by date has passed
 *   'allowed'  — gated severity, allowlisted and in date
 *   'reported' — below the gate
 * plus allowlist entries that matched nothing (`stale`, safe to prune).
 */
export function evaluate(report, allowlist, today, scope) {
  const entries = (allowlist?.entries ?? []).filter((e) => !scope || !e.scope || e.scope === scope);
  const used = new Set();
  const rows = advisoriesOf(report).map((a) => {
    if (!GATED.has(a.severity)) return { ...a, verdict: 'reported' };
    const idx = entries.findIndex((e) => e.ghsa === a.id && e.package === a.package);
    if (idx < 0) return { ...a, verdict: 'blocked' };
    used.add(idx);
    const e = entries[idx];
    if (!e.until || String(e.until) < today) return { ...a, verdict: 'expired', until: e.until, ticket: e.ticket };
    return { ...a, verdict: 'allowed', until: e.until, ticket: e.ticket };
  });
  const stale = entries.filter((_, i) => !used.has(i));
  const failed = rows.some((r) => r.verdict === 'blocked' || r.verdict === 'expired');
  return { rows, stale, failed };
}

function runNpmAudit() {
  // npm audit exits non-zero whenever it finds anything; the JSON is what counts.
  const r = spawnSync('npm', ['audit', '--json'], { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`npm audit did not return JSON (exit ${r.status}): ${String(r.stderr).slice(0, 500)}`);
  }
}

function main(argv) {
  const at = argv.indexOf('--report');
  let report;
  try {
    report = at >= 0 ? JSON.parse(readFileSync(argv[at + 1], 'utf8')) : runNpmAudit();
  } catch (err) {
    // Fail closed: "could not measure" must not read as "nothing found".
    console.error(`audit-gate: could not get an audit report — ${err instanceof Error ? err.message : err}`);
    return 2;
  }
  if (report?.error) {
    console.error(`audit-gate: npm audit failed — ${JSON.stringify(report.error).slice(0, 500)}`);
    return 2;
  }
  const allowlist = JSON.parse(readFileSync(new URL('./audit-allowlist.json', import.meta.url), 'utf8'));
  const today = new Date().toISOString().slice(0, 10);
  const sc = argv.indexOf('--scope');
  const scope = sc >= 0 ? argv[sc + 1] : basename(process.cwd());
  const { rows, stale, failed } = evaluate(report, allowlist, today, scope);

  const order = { blocked: 0, expired: 1, allowed: 2, reported: 3 };
  rows.sort((a, b) => order[a.verdict] - order[b.verdict] || a.package.localeCompare(b.package));
  for (const r of rows) {
    const extra = r.verdict === 'allowed' || r.verdict === 'expired' ? ` (${r.ticket}, review by ${r.until})` : '';
    console.log(`${r.verdict.padEnd(8)} ${r.severity.padEnd(8)} ${r.package} ${r.id}${extra} — ${r.title}`);
  }
  for (const e of stale) {
    console.log(`stale    allowlist entry ${e.package} ${e.ghsa} no longer reported — remove it`);
  }
  const n = (v) => rows.filter((r) => r.verdict === v).length;
  console.log(
    `audit-gate [${scope}]: ${n('blocked')} blocked, ${n('expired')} expired, ${n('allowed')} allowlisted, ${n('reported')} below the gate (moderate/low)`,
  );
  if (failed) {
    console.error(
      'audit-gate: FAILED. Upgrade the package, or — only after reading the advisory — add it to scripts/audit-allowlist.json with a reason, a ticket and a review-by date.',
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
