/** PT43 — the CI dependency gate's decision logic (scripts/audit-gate.mjs). DB-free. */
import { describe, it, expect } from 'vitest';
// A plain .mjs script with no type declarations; vitest runs it as-is.
import { advisoriesOf, evaluate, ghsaOf } from '../../scripts/audit-gate.mjs';
import { readFileSync } from 'node:fs';

const adv = (pkg: string, ghsa: string, severity: string) => ({
  source: 1,
  name: pkg,
  title: `${pkg} problem`,
  url: `https://github.com/advisories/${ghsa}`,
  severity,
  range: '<9',
});

/** The shape `npm audit --json` (v2) prints. */
const report = {
  auditReportVersion: 2,
  vulnerabilities: {
    zod: { name: 'zod', severity: 'high', via: [adv('zod', 'GHSA-aaaa-bbbb-cccc', 'high')] },
    qs: { name: 'qs', severity: 'moderate', via: [adv('qs', 'GHSA-dddd-eeee-ffff', 'moderate')] },
    // A package vulnerable only THROUGH another one: `via` is a string; it has no advisory of its own.
    express: { name: 'express', severity: 'moderate', via: ['qs'] },
    tinypool: {
      name: 'tinypool',
      severity: 'critical',
      via: [adv('tinypool', 'GHSA-1111-2222-3333', 'critical'), adv('tinypool', 'GHSA-1111-2222-3333', 'critical')],
    },
  },
};

const entry = (pkg: string, ghsa: string, until: string, scope?: string) => ({
  package: pkg,
  ghsa,
  until,
  scope,
  reason: 'read and judged',
  ticket: 'PT43-fu',
});

describe('audit gate (PT43)', () => {
  it('extracts one row per (package, advisory), skipping string `via` links', () => {
    const rows = advisoriesOf(report);
    expect(rows.map((r: { package: string; id: string }) => `${r.package} ${r.id}`).sort()).toEqual([
      'qs GHSA-dddd-eeee-ffff',
      'tinypool GHSA-1111-2222-3333',
      'zod GHSA-aaaa-bbbb-cccc',
    ]);
    expect(ghsaOf('https://github.com/advisories/GHSA-mrhx-c7xc-m3w5')).toBe('GHSA-mrhx-c7xc-m3w5');
    expect(ghsaOf(undefined)).toBeNull();
  });

  it('fails on a high/critical advisory that is not allowlisted; moderate is reported, not gated', () => {
    const r = evaluate(report, { entries: [] }, '2026-11-21');
    expect(r.failed).toBe(true);
    const verdicts = Object.fromEntries(r.rows.map((x: { package: string; verdict: string }) => [x.package, x.verdict]));
    expect(verdicts).toEqual({ zod: 'blocked', tinypool: 'blocked', qs: 'reported' });
  });

  it('passes when every gated advisory is allowlisted and in date', () => {
    const allow = {
      entries: [entry('zod', 'GHSA-aaaa-bbbb-cccc', '2027-02-28'), entry('tinypool', 'GHSA-1111-2222-3333', '2027-02-28')],
    };
    const r = evaluate(report, allow, '2026-11-21');
    expect(r.failed).toBe(false);
    expect(r.stale).toEqual([]);
  });

  it('fails again once an entry is past its review-by date', () => {
    const allow = {
      entries: [entry('zod', 'GHSA-aaaa-bbbb-cccc', '2026-11-20'), entry('tinypool', 'GHSA-1111-2222-3333', '2027-02-28')],
    };
    const r = evaluate(report, allow, '2026-11-21');
    expect(r.failed).toBe(true);
    expect(r.rows.find((x: { package: string }) => x.package === 'zod').verdict).toBe('expired');
  });

  it('an entry must match package AND advisory: the same GHSA on another package is not covered', () => {
    const allow = {
      entries: [entry('not-zod', 'GHSA-aaaa-bbbb-cccc', '2027-02-28'), entry('tinypool', 'GHSA-1111-2222-3333', '2027-02-28')],
    };
    expect(evaluate(report, allow, '2026-11-21').failed).toBe(true);
  });

  it('applies only the entries for its scope, and reports in-scope entries that matched nothing as stale', () => {
    const allow = {
      entries: [
        entry('zod', 'GHSA-aaaa-bbbb-cccc', '2027-02-28', 'api'),
        entry('tinypool', 'GHSA-1111-2222-3333', '2027-02-28', 'api'),
        entry('jspdf', 'GHSA-9999-9999-9999', '2027-02-28', 'web'),
        entry('gone', 'GHSA-0000-0000-0000', '2027-02-28', 'api'),
      ],
    };
    const api = evaluate(report, allow, '2026-11-21', 'api');
    expect(api.failed).toBe(false);
    expect(api.stale.map((e: { package: string }) => e.package)).toEqual(['gone']);
    // From web's point of view the api entries do not exist.
    expect(evaluate(report, allow, '2026-11-21', 'web').failed).toBe(true);
  });

  it('the committed allowlist is well-formed: every entry has scope, package, GHSA, reason, ticket, a real date', () => {
    const file = JSON.parse(readFileSync(new URL('../../scripts/audit-allowlist.json', import.meta.url), 'utf8'));
    expect(file.entries.length).toBeGreaterThan(0);
    for (const e of file.entries) {
      expect(['api', 'web']).toContain(e.scope);
      expect(e.package).toMatch(/\S/);
      expect(e.ghsa).toMatch(/^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/);
      expect(e.reason.length).toBeGreaterThan(20);
      expect(e.ticket).toMatch(/\S/);
      expect(e.until).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(e.until))).toBe(false);
    }
  });
});
