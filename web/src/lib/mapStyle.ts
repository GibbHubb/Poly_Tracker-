import type { StyleSpecification } from 'maplibre-gl';

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || '';

/**
 * MapLibre style backed by Mapbox satellite-streets-v12 raster tiles.
 * Raster (rather than the vector style URL) keeps the service worker tile
 * cache trivial to reason about for offline use.
 */
export function satelliteStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {
      satellite: {
        type: 'raster',
        tiles: [
          `https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/tiles/512/{z}/{x}/{y}@2x?access_token=${MAPBOX_TOKEN}`,
        ],
        tileSize: 512,
        attribution: '© Mapbox © Maxar',
      },
    },
    layers: [{ id: 'satellite', type: 'raster', source: 'satellite' }],
  };
}

// Australia-wide default view until a farm has features to fit to.
export const AUSTRALIA_CENTER: [number, number] = [134.0, -25.5];
export const AUSTRALIA_ZOOM = 3.6;

export const FEATURE_COLORS: Record<string, string> = {
  trough: '#38bdf8',
  turkey_nest: '#a78bfa',
  bore: '#f59e0b',
  gate: '#f472b6',
  tank: '#34d399',
  other: '#e2e8f0',
};
