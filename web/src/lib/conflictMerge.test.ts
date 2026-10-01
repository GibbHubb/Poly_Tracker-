// @vitest-environment node
/** PT40 — the merge dialog lists only fields a person can meaningfully choose between. */
import { describe, expect, it } from 'vitest';
import { buildMergedPatch, diffFields, IGNORED_KEYS } from './conflictMerge';

// What the map's edit dialog sends for a poly run: the attribute set, no version.
const mine = {
  properties: { name: 'Mine', color: '#ff0000', notes: null, diameter_mm: 50 },
};
// What GET /poly-runs/:id returns after someone else's save.
const server = {
  properties: {
    id: 'pr-1',
    name: 'Theirs',
    color: '#ff0000',
    notes: null,
    diameter_mm: '63',
    version: 4,
    created_at: '2026-09-30T10:00:00Z',
    updated_at: '2026-10-01T09:00:00Z',
    length_m: 120.5,
  },
};

describe('diffFields', () => {
  it('never offers version or timestamps as mergeable fields', () => {
    const fields = diffFields(mine, server).map((d) => d.field);
    expect(fields).not.toContain('version');
    expect(fields).not.toContain('updated_at');
    expect(fields).not.toContain('created_at');
    expect(fields.sort()).toEqual(['diameter_mm', 'name']);
  });

  it('ignores a version difference even when both sides carry one', () => {
    const diffs = diffFields(
      { properties: { name: 'a', version: 3 } },
      { properties: { name: 'a', version: 4 } },
    );
    expect(diffs).toEqual([]);
  });

  it('treats version, created_at and updated_at as bookkeeping', () => {
    for (const k of ['version', 'created_at', 'updated_at']) expect(IGNORED_KEYS.has(k)).toBe(true);
  });
});

describe('buildMergedPatch', () => {
  it('does not send bookkeeping fields in the PATCH body', () => {
    const patch = buildMergedPatch(
      { properties: { ...mine.properties, version: 3, updated_at: 'x' } },
      server,
      new Set(['diameter_mm']),
    );
    expect(patch.properties).toEqual({ name: 'Mine', color: '#ff0000', notes: null, diameter_mm: 63 });
  });
});
