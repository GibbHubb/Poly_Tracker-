// @vitest-environment jsdom
/**
 * PT34 review — the phone bottom sheet: a named, non-modal dialog that takes focus on open,
 * closes on Escape, and hands focus back to the List button (FarmMap's closeList, mirrored
 * by the harness below). At `md` and up it is the plain aside it always was.
 */
import { act, useCallback, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeatureSidebar } from './FeatureSidebar';
import { PHONE_QUERY } from '../hooks/useIsPhone';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const empty = { type: 'FeatureCollection' as const, features: [] };
let container: HTMLDivElement;
let root: Root;

function stubViewport(phone: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: phone && query === PHONE_QUERY,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

function Harness() {
  const [open, setOpen] = useState(false);
  const listBtn = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => {
    setOpen(false);
    listBtn.current?.focus();
  }, []);
  return (
    <>
      <button ref={listBtn} data-testid="list" onClick={() => setOpen(true)}>
        List
      </button>
      <div data-testid="map" tabIndex={-1}>
        map
      </div>
      <FeatureSidebar paddocks={empty} polyRuns={empty} features={empty} onSelect={() => {}} open={open} onClose={close} />
    </>
  );
}

const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const sheet = () => q('feature-list')!;
const isOpen = () => !sheet().className.split(/\s+/).includes('max-md:hidden');
const escape = (el: Element) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });

function mount(phone: boolean) {
  stubViewport(phone);
  act(() => root.render(<Harness />));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('FeatureSidebar as the phone sheet', () => {
  it('is a named, non-modal dialog', () => {
    mount(true);
    expect(sheet().getAttribute('role')).toBe('dialog');
    expect(sheet().getAttribute('aria-label')).toBe('Features');
    expect(sheet().getAttribute('aria-modal')).toBe('false');
  });

  it('takes focus when it opens', () => {
    mount(true);
    act(() => q('list')!.click());
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(sheet());
  });

  it('closes on Escape from inside it and gives focus back to List', () => {
    mount(true);
    act(() => q('list')!.click());
    const search = sheet().querySelector('input')!;
    search.focus();
    escape(search);
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(q('list'));
  });

  it('closes from its Close button and gives focus back to List', () => {
    mount(true);
    act(() => q('list')!.click());
    act(() => sheet().querySelector<HTMLButtonElement>('button[aria-label="Close feature list"]')!.click());
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(q('list'));
  });

  it('is not a focus trap: focus can leave for the map while it stays open', () => {
    mount(true);
    act(() => q('list')!.click());
    act(() => q('map')!.focus());
    expect(document.activeElement).toBe(q('map'));
    expect(isOpen()).toBe(true);
  });
});

describe('FeatureSidebar at md and up', () => {
  it('stays a plain named aside: no dialog role, no tab stop, Escape does nothing', () => {
    mount(false);
    expect(sheet().getAttribute('role')).toBeNull();
    expect(sheet().getAttribute('aria-label')).toBe('Features');
    expect(sheet().hasAttribute('tabindex')).toBe(false);
    act(() => q('list')!.click());
    escape(sheet().querySelector('input')!);
    expect(isOpen()).toBe(true);
  });
});
