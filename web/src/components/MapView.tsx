import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import {
  AUSTRALIA_CENTER,
  AUSTRALIA_ZOOM,
  satelliteStyle,
} from '../lib/mapStyle';
import type { GeoJsonFeature } from '../lib/api';

interface MapViewProps {
  onCreate?: (feature: GeoJsonFeature) => void;
  onReady?: (map: maplibregl.Map) => void;
}

/**
 * MapLibre canvas with Mapbox-GL-Draw wired in. Drawn shapes are pushed up
 * via onCreate as a bare GeoJSON Feature; the parent decides which collection
 * (paddock / poly-run / point feature) it belongs to.
 */
export function MapView({ onCreate, onReady }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: satelliteStyle(),
      center: AUSTRALIA_CENTER,
      zoom: AUSTRALIA_ZOOM,
      attributionControl: { compact: true },
    });
    mapRef.current = map;

    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(
      new maplibregl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: true,
      }),
      'top-right',
    );

    const draw = new MapboxDraw({
      displayControlsDefault: false,
      controls: { point: true, line_string: true, polygon: true, trash: true },
    });
    // MapboxDraw targets mapbox-gl typings; MapLibre is API-compatible here.
    map.addControl(draw as unknown as maplibregl.IControl, 'top-left');

    map.on('draw.create', (e: { features: GeoJsonFeature[] }) => {
      const f = e.features[0];
      if (f && onCreate) onCreate(f);
    });

    map.on('load', () => onReady?.(map));

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} className="h-full w-full" />;
}
