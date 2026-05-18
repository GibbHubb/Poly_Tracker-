import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import MapboxDraw, { type DrawCustomMode } from '@mapbox/mapbox-gl-draw';
import {
  AUSTRALIA_CENTER,
  AUSTRALIA_ZOOM,
  DRAW_STYLES,
  basemapConfig,
  satelliteStyle,
} from '../lib/mapStyle';
import { CircleMode } from '../lib/circleMode';
import { toSource } from '../lib/geo';
import { useAppStore } from '../lib/store';
import type { GeoJsonFeature, GeoJsonFeatureCollection } from '../lib/api';

interface MapViewProps {
  paddocks: GeoJsonFeatureCollection;
  polyRuns: GeoJsonFeatureCollection;
  features: GeoJsonFeatureCollection;
  onCreate?: (feature: GeoJsonFeature) => void;
  onReady?: (map: maplibregl.Map) => void;
}

const EMPTY = { type: 'FeatureCollection' as const, features: [] };

/**
 * MapLibre canvas with Mapbox-GL-Draw wired in, plus rendering of already-
 * saved paddocks / poly runs / points coloured by each feature's `color`
 * property (falling back to a per-geometry default). Drawn shapes are pushed
 * up via onCreate; the parent persists them and the new row then renders via
 * these layers (the just-drawn Draw shape is cleared to avoid a duplicate).
 */
export function MapView({
  paddocks,
  polyRuns,
  features,
  onCreate,
  onReady,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const drawRef = useRef<MapboxDraw | null>(null);
  const [ready, setReady] = useState(false);
  // Which multi-point shape is being drawn ('line' | 'polygon'), or null.
  const [drawingShape, setDrawingShape] = useState<
    'line' | 'polygon' | 'circle' | null
  >(null);
  const visibleLayers = useAppStore((s) => s.visibleLayers);
  const basemap = useAppStore((s) => s.basemap);

  // Keep latest callbacks without re-running the init effect.
  const cbRef = useRef({ onCreate, onReady });
  cbRef.current = { onCreate, onReady };

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: satelliteStyle(useAppStore.getState().basemap),
      center: AUSTRALIA_CENTER,
      zoom: AUSTRALIA_ZOOM,
      attributionControl: false,
      // Required so the WebGL canvas can be read back for PDF/PNG export.
      preserveDrawingBuffer: true,
    });
    mapRef.current = map;

    map.addControl(
      new maplibregl.AttributionControl({ compact: true }),
      'bottom-right',
    );
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(
      new maplibregl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: true,
      }),
      'top-right',
    );

    // MapLibre compatibility: mapbox-gl-draw builds its control DOM with
    // Mapbox CSS classes; MapLibre's control layer only wires up elements
    // using its own classes, so without this remap the buttons are inert.
    const drawConstants = (
      MapboxDraw as unknown as {
        constants: { classes: Record<string, string> };
      }
    ).constants;
    drawConstants.classes.CONTROL_BASE = 'maplibregl-ctrl';
    drawConstants.classes.CONTROL_PREFIX = 'maplibregl-ctrl-';
    drawConstants.classes.CONTROL_GROUP = 'maplibregl-ctrl-group';

    const baseModes = (
      MapboxDraw as unknown as { modes: Record<string, unknown> }
    ).modes;
    const draw = new MapboxDraw({
      displayControlsDefault: false,
      controls: { point: true, line_string: true, polygon: true, trash: true },
      styles: DRAW_STYLES,
      modes: {
        ...baseModes,
        draw_circle: CircleMode as unknown as DrawCustomMode,
      },
    });
    drawRef.current = draw;

    // Add Draw + saved-feature layers only after the style has loaded —
    // mapbox-gl-draw injects sources/layers in onAdd and throws if added
    // before the style is ready, which leaves the buttons inert.
    map.on('load', () => {
      map.addSource('saved-paddocks', { type: 'geojson', data: EMPTY });
      map.addSource('saved-polyruns', { type: 'geojson', data: EMPTY });
      map.addSource('saved-features', { type: 'geojson', data: EMPTY });

      map.addLayer({
        id: 'saved-paddocks-fill',
        type: 'fill',
        source: 'saved-paddocks',
        paint: {
          'fill-color': ['coalesce', ['get', 'color'], '#22d3ee'],
          'fill-opacity': 0.2,
        },
      });
      map.addLayer({
        id: 'saved-paddocks-line',
        type: 'line',
        source: 'saved-paddocks',
        paint: {
          'line-color': ['coalesce', ['get', 'color'], '#22d3ee'],
          'line-width': 3,
        },
      });
      map.addLayer({
        id: 'saved-polyruns-line',
        type: 'line',
        source: 'saved-polyruns',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['coalesce', ['get', 'color'], '#f97316'],
          'line-width': 4,
        },
      });
      map.addLayer({
        id: 'saved-features-circle',
        type: 'circle',
        source: 'saved-features',
        paint: {
          'circle-radius': 6,
          'circle-color': ['coalesce', ['get', 'color'], '#38bdf8'],
          'circle-stroke-color': '#0f172a',
          'circle-stroke-width': 2,
        },
      });

      // MapboxDraw targets mapbox-gl typings; MapLibre is API-compatible.
      map.addControl(draw as unknown as maplibregl.IControl, 'top-left');
      map.on('draw.create', (e: { features: GeoJsonFeature[] }) => {
        const f = e.features[0];
        if (!f) return;
        setDrawingShape(null);
        cbRef.current.onCreate?.(f);
        // Clear from Draw; it will reappear via the saved-* layers once the
        // parent has persisted and reloaded the collection.
        if (f.id !== undefined) draw.delete(String(f.id));
      });

      // Track whether a multi-point shape is in progress so we can show an
      // explicit Finish/Cancel banner (points complete on a single click).
      map.on('draw.modechange', (e: { mode: string }) => {
        setDrawingShape(
          e.mode === 'draw_line_string'
            ? 'line'
            : e.mode === 'draw_polygon'
              ? 'polygon'
              : e.mode === 'draw_circle'
                ? 'circle'
                : null,
        );
      });

      setReady(true);
      cbRef.current.onReady?.(map);
    });

    return () => {
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
  }, []);

  // Push collection data into the sources whenever it changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource('saved-paddocks') as maplibregl.GeoJSONSource)?.setData(
      toSource(paddocks),
    );
    (map.getSource('saved-polyruns') as maplibregl.GeoJSONSource)?.setData(
      toSource(polyRuns),
    );
    (map.getSource('saved-features') as maplibregl.GeoJSONSource)?.setData(
      toSource(features),
    );
  }, [ready, paddocks, polyRuns, features]);

  // Reflect LayerToggle visibility.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const vis = (on: boolean) => (on ? 'visible' : 'none');
    map.setLayoutProperty(
      'saved-paddocks-fill',
      'visibility',
      vis(visibleLayers.paddocks),
    );
    map.setLayoutProperty(
      'saved-paddocks-line',
      'visibility',
      vis(visibleLayers.paddocks),
    );
    map.setLayoutProperty(
      'saved-polyruns-line',
      'visibility',
      vis(visibleLayers.polyRuns),
    );
    map.setLayoutProperty(
      'saved-features-circle',
      'visibility',
      vis(visibleLayers.features),
    );
  }, [ready, visibleLayers]);

  // Swap the basemap provider in place (tileSize differs, so re-create the
  // source + layer) keeping it beneath the saved-feature layers and Draw.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const c = basemapConfig(basemap);
    if (map.getLayer('satellite')) map.removeLayer('satellite');
    if (map.getSource('satellite')) map.removeSource('satellite');
    map.addSource('satellite', {
      type: 'raster',
      tiles: c.tiles,
      tileSize: c.tileSize,
      maxzoom: c.maxzoom,
      attribution: c.attribution,
    });
    const firstSaved = map.getLayer('saved-paddocks-fill')
      ? 'saved-paddocks-fill'
      : undefined;
    map.addLayer(
      { id: 'satellite', type: 'raster', source: 'satellite', maxzoom: 24 },
      firstSaved,
    );
  }, [ready, basemap]);

  const finishDrawing = () => {
    // mapbox-gl-draw completes a line/polygon on Enter; synthesise it with
    // keyCode defined (constructed KeyboardEvents default keyCode to 0).
    const el = mapRef.current?.getContainer();
    if (!el) return;
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    Object.defineProperty(ev, 'keyCode', { get: () => 13 });
    el.dispatchEvent(ev);
  };

  const cancelDrawing = () => {
    const draw = drawRef.current;
    if (draw) {
      draw.changeMode('simple_select');
      draw.deleteAll(); // clear any half-drawn transient shape
    }
    setDrawingShape(null);
  };

  const startCircle = () => {
    drawRef.current?.changeMode('draw_circle');
    setDrawingShape('circle');
  };

  const hint =
    drawingShape === 'circle'
      ? 'Click the centre, move out, then click again (or Finish)'
      : `Click to add points · drawing a ${drawingShape}`;

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      <button
        onClick={startCircle}
        title="Draw circle"
        className="absolute left-3 top-[150px] z-20 h-[29px] w-[29px] rounded bg-white text-base leading-none text-slate-800 shadow"
      >
        ◯
      </button>
      {drawingShape && (
        <div className="absolute bottom-6 left-1/2 z-20 flex -translate-x-1/2 items-center gap-3 rounded-lg bg-slate-900/95 px-4 py-2 text-sm text-slate-100 shadow-xl">
          <span>{hint}</span>
          <button
            onClick={finishDrawing}
            className="rounded-md bg-brand px-3 py-1 font-medium text-white"
          >
            Finish
          </button>
          <button
            onClick={cancelDrawing}
            className="rounded-md bg-slate-700 px-3 py-1"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
