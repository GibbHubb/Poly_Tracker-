// @vitest-environment node
/** PT41 — the custom circle draw mode, driven with a fake mapbox-gl-draw context. */
import { describe, expect, it, vi } from 'vitest';
import { CircleMode } from './circleMode';
import { geometryProblem } from './geometryCheck';
import type { GeoJsonGeometry } from './api';

function harness() {
  let coords: number[][][] = [[]];
  const poly = {
    id: 'c1',
    setCoordinates: (c: number[][][]) => {
      coords = c;
    },
    toGeoJSON: () => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: coords }, properties: {} }),
  };
  const fired: { type: string; data: { features: { geometry: GeoJsonGeometry }[] } }[] = [];
  const ctx = {
    newFeature: vi.fn(() => poly),
    addFeature: vi.fn(),
    deleteFeature: vi.fn(),
    changeMode: vi.fn(),
    updateUIClasses: vi.fn(),
    map: { fire: (type: string, data: never) => fired.push({ type, data }) },
  };
  const state = CircleMode.onSetup.call(ctx);
  const at = (lng: number, lat: number) => ({ lngLat: { lng, lat } });
  return { ctx, state, fired, at };
}

describe('CircleMode', () => {
  it('click, drag, click: emits a closed ring the API will accept', () => {
    const { ctx, state, fired, at } = harness();
    CircleMode.onClick.call(ctx, state, at(150, -26));
    CircleMode.onMouseMove.call(ctx, state, at(150.001, -26));
    CircleMode.onClick.call(ctx, state, at(150.001, -26));
    expect(fired).toHaveLength(1);
    const g = fired[0]!.data.features[0]!.geometry;
    expect(geometryProblem(g)).toBeNull();
    expect(ctx.changeMode).toHaveBeenCalledWith('simple_select', { featureIds: ['c1'] });
  });

  it('click, click with no drag emits an empty ring, which the draw-tool check refuses (PT41)', () => {
    const { ctx, state, fired, at } = harness();
    CircleMode.onClick.call(ctx, state, at(150, -26));
    CircleMode.onClick.call(ctx, state, at(150, -26));
    expect(geometryProblem(fired[0]!.data.features[0]!.geometry)).not.toBeNull();
  });

  it('Esc discards, Enter finishes once sized, stopping before sizing drops the placeholder', () => {
    const a = harness();
    CircleMode.onKeyUp.call(a.ctx, a.state, { keyCode: 27 });
    expect(a.ctx.deleteFeature).toHaveBeenCalledWith('c1', { silent: true });

    const b = harness();
    CircleMode.onClick.call(b.ctx, b.state, b.at(150, -26));
    CircleMode.onMouseMove.call(b.ctx, b.state, b.at(150.002, -26));
    CircleMode.onKeyUp.call(b.ctx, b.state, { keyCode: 13 });
    expect(b.fired).toHaveLength(1);

    const c = harness();
    CircleMode.onStop.call(c.ctx, c.state);
    expect(c.ctx.deleteFeature).toHaveBeenCalled();
    const shown: unknown[] = [];
    CircleMode.toDisplayFeatures(c.state, { properties: { active: 'false' } }, (g) => shown.push(g));
    expect(shown).toEqual([{ properties: { active: 'true' } }]);
  });
});
