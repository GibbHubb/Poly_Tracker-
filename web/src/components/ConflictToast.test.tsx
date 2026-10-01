// @vitest-environment jsdom
/**
 * PT40 — the conflict toast on the map, and the review dialog it opens.
 * Rendered with react-dom + act directly (the repo has no testing-library);
 * IndexedDB is fake-indexeddb, so the Settings page reads a real conflict log.
 */
import 'fake-indexeddb/auto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictToast } from './ConflictToast';
import { Settings } from '../pages/Settings';
import { db } from '../lib/db';
import { api } from '../lib/api';
import { recordConflict, useConflictNotice } from '../lib/conflictNotice';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

function render(initial: string) {
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/farms/:farmId" element={<div>map</div>} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
        <LocationProbe />
        <ConflictToast />
      </MemoryRouter>,
    );
  });
}

/** Let Dexie reads and the fetch mock settle, then flush React. */
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 25));
  });
const q = (sel: string) => container.querySelector(sel);
const buttonByText = (t: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === t);

beforeEach(async () => {
  await db.conflicts.clear();
  useConflictNotice.getState().dismiss();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('ConflictToast', () => {
  it('renders nothing until a conflict is recorded', () => {
    render('/farms/f1');
    expect(q('[data-testid="conflict-toast"]')).toBeNull();
  });

  it('appears on the map when a poly-run save is refused, and Review opens the merge dialog', async () => {
    vi.spyOn(api, 'getByPath').mockResolvedValue({
      type: 'Feature',
      geometry: null,
      properties: {
        id: 'r1',
        name: 'Theirs',
        diameter_mm: 50,
        version: 7,
        updated_at: '2026-10-01T09:00:00Z',
      },
    });
    render('/farms/f1');

    await act(async () => {
      await recordConflict({
        id: 'c1',
        op: 'update',
        endpoint: '/farms/f1/poly-runs/r1',
        method: 'PATCH',
        status: 412,
        resolvedAt: Date.now(),
        payload: { properties: { name: 'Mine', diameter_mm: 50 } },
      });
    });

    const toast = q('[data-testid="conflict-toast"]');
    expect(toast?.getAttribute('role')).toBe('alert');
    expect(toast?.textContent).toContain(
      'Your change to this poly run conflicted with a newer edit',
    );

    act(() => buttonByText('Review')!.click());
    await settle();
    await settle();

    // Toast gone, merge dialog open for that conflict, query param consumed.
    expect(q('[data-testid="conflict-toast"]')).toBeNull();
    expect(q('[data-testid="loc"]')?.textContent).toBe('/settings');
    expect(container.textContent).toContain('Review changes before re-applying');
    const fieldCells = [...container.querySelectorAll('tbody tr td:first-child')].map(
      (td) => td.textContent,
    );
    expect(fieldCells).toEqual(['name']);
  });

  it('Dismiss hides it without leaving the map', () => {
    render('/farms/f1');
    act(() => useConflictNotice.getState().notify('c2', '/farms/f1/paddocks/p1'));
    expect(q('[data-testid="conflict-toast"]')?.textContent).toContain('paddock');
    act(() => (q('button[aria-label="Dismiss"]') as HTMLButtonElement).click());
    expect(q('[data-testid="conflict-toast"]')).toBeNull();
    expect(q('[data-testid="loc"]')?.textContent).toBe('/farms/f1');
  });
});
