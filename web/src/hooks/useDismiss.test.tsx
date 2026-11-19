// @vitest-environment jsdom
/** PT34 review — the phone ⋯ menu closes on Escape and on a press outside it. */
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useDismiss, type DismissReason } from './useDismiss';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const reasons: DismissReason[] = [];

/** The same wiring as FarmMap's ⋯ menu. */
function Menu() {
  const [open, setOpen] = useState(true);
  const wrap = useRef<HTMLDivElement | null>(null);
  const btn = useRef<HTMLButtonElement | null>(null);
  useDismiss(open, wrap, (r) => {
    reasons.push(r);
    setOpen(false);
    if (r === 'escape') btn.current?.focus();
  });
  return (
    <>
      <div ref={wrap}>
        <button ref={btn} data-testid="more" onClick={() => setOpen((v) => !v)}>
          more
        </button>
        {open && (
          <div data-testid="menu">
            <button data-testid="item">Gallery</button>
          </div>
        )}
      </div>
      <div data-testid="map">map</div>
    </>
  );
}

const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const press = (el: Element) =>
  act(() => {
    el.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  });
const key = (k: string, el: Element = document.body) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });

beforeEach(() => {
  reasons.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Menu />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useDismiss (phone ⋯ menu)', () => {
  it('closes on Escape and puts focus back on the ⋯ button', () => {
    q('item')!.focus();
    key('Escape', q('item')!);
    expect(q('menu')).toBeNull();
    expect(reasons).toEqual(['escape']);
    expect(document.activeElement).toBe(q('more'));
  });

  it('closes on a press outside it (the map), without taking focus', () => {
    press(q('map')!);
    expect(q('menu')).toBeNull();
    expect(reasons).toEqual(['outside']);
    expect(document.activeElement).not.toBe(q('more'));
  });

  it('stays open on a press inside it, and on other keys', () => {
    press(q('item')!);
    key('Enter');
    expect(q('menu')).not.toBeNull();
    expect(reasons).toEqual([]);
  });

  it('stops listening once closed', () => {
    key('Escape');
    key('Escape');
    press(q('map')!);
    expect(reasons).toEqual(['escape']);
  });
});
