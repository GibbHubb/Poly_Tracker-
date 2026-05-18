import type { StyleSpecification } from 'maplibre-gl';

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || '';

export type BasemapProvider = 'mapbox' | 'esri';

export interface BasemapConfig {
  tiles: string[];
  tileSize: number;
  maxzoom: number;
  attribution: string;
}

/** Tile config per provider — quality varies by location, so users switch. */
export function basemapConfig(provider: BasemapProvider): BasemapConfig {
  if (provider === 'esri') {
    return {
      tiles: [
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      ],
      tileSize: 256,
      maxzoom: 22,
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    };
  }
  return {
    tiles: [
      `https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}@2x.jpg90?access_token=${MAPBOX_TOKEN}`,
    ],
    tileSize: 512,
    maxzoom: 22,
    attribution: '© Mapbox © Maxar',
  };
}

/**
 * MapLibre style backed by Mapbox satellite raster tiles (Maxar imagery) at
 * retina @2x. Esri's free imagery was tried but returns "no data" over remote
 * AU; Mapbox at least has coverage everywhere and over-zooms (upscales)
 * gracefully instead of going blank. `maxzoom` on the source lets MapLibre
 * keep zooming past the native tile depth at paddock scale.
 */
export function satelliteStyle(
  provider: BasemapProvider = 'mapbox',
): StyleSpecification {
  const c = basemapConfig(provider);
  return {
    version: 8,
    sources: {
      satellite: {
        type: 'raster',
        tiles: c.tiles,
        tileSize: c.tileSize,
        maxzoom: c.maxzoom,
        attribution: c.attribution,
      },
    },
    layers: [
      { id: 'satellite', type: 'raster', source: 'satellite', maxzoom: 24 },
    ],
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

// User-pickable colours for drawn features (name shown in the create dialog).
export const PALETTE: { name: string; value: string }[] = [
  { name: 'Orange', value: '#f97316' },
  { name: 'Cyan', value: '#22d3ee' },
  { name: 'Lime', value: '#84cc16' },
  { name: 'Red', value: '#ef4444' },
  { name: 'Violet', value: '#a78bfa' },
  { name: 'Amber', value: '#f59e0b' },
  { name: 'White', value: '#ffffff' },
];

/**
 * Explicit mapbox-gl-draw theme. The library's built-in defaults only paint
 * reliably on Mapbox GL; on MapLibre the line/fill layers can fail to render
 * (symptom: "only dots"). Defining the layers ourselves fixes that and gives
 * a high-contrast look against satellite imagery.
 */
export const DRAW_STYLES: object[] = [
  {
    id: 'gl-draw-polygon-fill',
    type: 'fill',
    filter: ['all', ['==', '$type', 'Polygon']],
    paint: { 'fill-color': '#22d3ee', 'fill-opacity': 0.2 },
  },
  {
    id: 'gl-draw-polygon-stroke',
    type: 'line',
    filter: ['all', ['==', '$type', 'Polygon']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#22d3ee', 'line-width': 3 },
  },
  {
    id: 'gl-draw-line',
    type: 'line',
    filter: ['all', ['==', '$type', 'LineString']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#f97316', 'line-width': 4 },
  },
  {
    id: 'gl-draw-polygon-and-line-vertex-halo',
    type: 'circle',
    filter: ['all', ['==', 'meta', 'vertex'], ['==', '$type', 'Point']],
    paint: { 'circle-radius': 7, 'circle-color': '#ffffff' },
  },
  {
    id: 'gl-draw-polygon-and-line-vertex',
    type: 'circle',
    filter: ['all', ['==', 'meta', 'vertex'], ['==', '$type', 'Point']],
    paint: { 'circle-radius': 5, 'circle-color': '#f59e0b' },
  },
  {
    id: 'gl-draw-midpoint',
    type: 'circle',
    filter: ['all', ['==', 'meta', 'midpoint']],
    paint: { 'circle-radius': 4, 'circle-color': '#f59e0b' },
  },
  {
    id: 'gl-draw-point-halo',
    type: 'circle',
    filter: ['all', ['==', '$type', 'Point'], ['==', 'meta', 'feature']],
    paint: { 'circle-radius': 8, 'circle-color': '#ffffff' },
  },
  {
    id: 'gl-draw-point',
    type: 'circle',
    filter: ['all', ['==', '$type', 'Point'], ['==', 'meta', 'feature']],
    paint: { 'circle-radius': 6, 'circle-color': '#38bdf8' },
  },
];
