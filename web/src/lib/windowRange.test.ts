import { describe, expect, it } from 'vitest';
import { OVERSCAN, ROW_PITCH, windowRange } from './windowRange';

// PT32 — the windowed sidebar mounts only what can be seen (plus overscan).
describe('windowRange', () => {
  const vh = 640; // 20 rows of viewport
  it('mounts the first screen plus overscan when the list starts at the top', () => {
    expect(windowRange(0, vh, 5000)).toEqual([0, vh / ROW_PITCH + OVERSCAN]);
  });
  it('mounts nothing past the end of a short list', () => {
    expect(windowRange(0, vh, 5)).toEqual([0, 5]);
  });
  it('follows the scroll position', () => {
    const scrolled = 100 * ROW_PITCH; // list top is 100 rows above the viewport
    expect(windowRange(-scrolled, vh, 5000)).toEqual([100 - OVERSCAN, 100 + vh / ROW_PITCH + OVERSCAN]);
  });
  it('mounts only the overscan when the list starts below the viewport', () => {
    expect(windowRange(vh + 5 * ROW_PITCH, vh, 5000)).toEqual([0, 5]);
  });
  it('mounts nothing when the list is scrolled entirely past', () => {
    const [a, b] = windowRange(-(6000 * ROW_PITCH), vh, 5000);
    expect(a).toBe(5000);
    expect(b).toBe(5000);
  });
  it('clamps to the end of the list at the bottom', () => {
    const [, b] = windowRange(-(4990 * ROW_PITCH), vh, 5000);
    expect(b).toBe(5000);
  });
});
