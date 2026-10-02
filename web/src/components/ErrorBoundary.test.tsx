// @vitest-environment jsdom
/** PT35 — a render error leaves a message and a way back, not a white page; notices render. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';
import { Toaster } from './Toaster';
import { notify, useNotices } from '../lib/notify';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useNotices.setState({ notices: [] });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function Boom(): JSX.Element {
  throw new Error('kaboom in render');
}

describe('ErrorBoundary', () => {
  it('renders the fallback with a Reload button when a child throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    act(() => {
      root.render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>,
      );
    });
    const fallback = container.querySelector('[data-testid="error-boundary"]');
    expect(fallback).not.toBeNull();
    expect(fallback?.textContent).toContain('Something went wrong on this screen.');
    expect(fallback?.textContent).toContain('kaboom in render');
    expect([...container.querySelectorAll('button')].map((b) => b.textContent)).toContain('Reload');
  });

  it('renders children untouched when nothing throws', () => {
    act(() => {
      root.render(
        <ErrorBoundary>
          <p>fine</p>
        </ErrorBoundary>,
      );
    });
    expect(container.textContent).toBe('fine');
  });
});

describe('Toaster', () => {
  it('shows a notice and dismisses it', () => {
    act(() => root.render(<Toaster />));
    act(() => {
      notify('error', 'Saving the new point failed: no connection to the server.');
    });
    const n = container.querySelector('[data-testid="notice-error"]');
    expect(n?.getAttribute('role')).toBe('alert');
    expect(n?.textContent).toContain('Saving the new point failed');
    act(() => {
      (container.querySelector('[aria-label="Dismiss"]') as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-testid="notice-error"]')).toBeNull();
  });
});
