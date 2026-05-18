// Minimal click-based circle mode for mapbox-gl-draw: click once for the
// centre, move to size it, click again (or Enter) to finish. The result is a
// regular GeoJSON Polygon (a 64-point approximation), so it flows through the
// exact same pipeline as the polygon tool. Esc cancels.

const STEPS = 64;
const EARTH_RADIUS_M = 6_371_008.8;

type LngLat = [number, number];

/** Great-circle distance in metres between two [lng,lat] points. */
function distanceM(a: LngLat, b: LngLat): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** Build a closed polygon ring approximating a circle. */
function circleRing(center: LngLat, radiusM: number): LngLat[] {
  const ring: LngLat[] = [];
  const latRad = (center[1] * Math.PI) / 180;
  const dLat = (radiusM / EARTH_RADIUS_M) * (180 / Math.PI);
  const dLng = dLat / Math.max(Math.cos(latRad), 1e-6);
  for (let i = 0; i <= STEPS; i += 1) {
    const theta = (i / STEPS) * 2 * Math.PI;
    ring.push([
      center[0] + dLng * Math.cos(theta),
      center[1] + dLat * Math.sin(theta),
    ]);
  }
  return ring;
}

interface DrawFeature {
  id: string;
  setCoordinates(coords: LngLat[][]): void;
  toGeoJSON(): unknown;
}

interface CircleState {
  poly: DrawFeature;
  center: LngLat | null;
}

interface MouseLikeEvent {
  lngLat: { lng: number; lat: number };
}

interface KeyLikeEvent {
  keyCode: number;
}

// `this` context mapbox-gl-draw binds when calling mode methods.
interface CircleCtx {
  newFeature(spec: unknown): DrawFeature;
  addFeature(f: DrawFeature): void;
  deleteFeature(id: string, opts?: { silent: boolean }): void;
  changeMode(mode: string, opts?: unknown): void;
  updateUIClasses(classes: Record<string, string>): void;
  map: { fire(type: string, data: unknown): void };
}

export const CircleMode = {
  onSetup(this: CircleCtx): CircleState {
    const poly = this.newFeature({
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [[]] },
    });
    this.addFeature(poly);
    this.updateUIClasses({ mouse: 'add' });
    return { poly, center: null };
  },

  onClick(this: CircleCtx, state: CircleState, e: MouseLikeEvent): void {
    const ll: LngLat = [e.lngLat.lng, e.lngLat.lat];
    if (!state.center) {
      state.center = ll;
      return;
    }
    // Second click finalises.
    this.map.fire('draw.create', { features: [state.poly.toGeoJSON()] });
    this.changeMode('simple_select', { featureIds: [state.poly.id] });
  },

  onMouseMove(this: CircleCtx, state: CircleState, e: MouseLikeEvent): void {
    if (!state.center) return;
    const r = distanceM(state.center, [e.lngLat.lng, e.lngLat.lat]);
    state.poly.setCoordinates([circleRing(state.center, Math.max(r, 1))]);
  },

  onKeyUp(this: CircleCtx, state: CircleState, e: KeyLikeEvent): void {
    if (e.keyCode === 27) {
      // Esc — discard
      this.deleteFeature(state.poly.id, { silent: true });
      this.changeMode('simple_select');
    } else if (e.keyCode === 13 && state.center) {
      // Enter — finish
      this.map.fire('draw.create', { features: [state.poly.toGeoJSON()] });
      this.changeMode('simple_select', { featureIds: [state.poly.id] });
    }
  },

  onStop(this: CircleCtx, state: CircleState): void {
    // If aborted before sizing, drop the empty placeholder.
    if (!state.center) {
      this.deleteFeature(state.poly.id, { silent: true });
    }
  },

  toDisplayFeatures(
    _state: CircleState,
    geojson: { properties: { active: string } },
    display: (g: unknown) => void,
  ): void {
    geojson.properties.active = 'true';
    display(geojson);
  },
};
