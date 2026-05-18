import { jsPDF } from 'jspdf';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { Farm, GeoJsonFeatureCollection } from './api';
import { FEATURE_COLORS } from './mapStyle';

interface ExportArgs {
  map: MapLibreMap;
  farm: Farm | null;
  paddocks: GeoJsonFeatureCollection;
  polyRuns: GeoJsonFeatureCollection;
  features: GeoJsonFeatureCollection;
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [100, 116, 139];
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Resolve once the map has finished rendering the current view. */
function waitForIdle(map: MapLibreMap): Promise<void> {
  return new Promise((resolve) => {
    const done = () => resolve();
    const t = window.setTimeout(done, 4000); // safety cap
    map.once('idle', () => {
      window.clearTimeout(t);
      done();
    });
    map.triggerRepaint();
  });
}

/**
 * Build an A3-landscape PDF of exactly the current map view (centre, zoom,
 * basemap and all rendered features) plus a header and a feature list. Runs
 * entirely client-side — no server/Puppeteer — so it always matches what the
 * user sees on screen.
 */
export async function exportFarmPdf({
  map,
  farm,
  paddocks,
  polyRuns,
  features,
}: ExportArgs): Promise<void> {
  await waitForIdle(map);
  const img = map.getCanvas().toDataURL('image/png');

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a3' });
  const pageW = 420;
  const pageH = 297;
  const margin = 10;
  const colW = 78; // right-hand info column

  // Header
  doc.setFontSize(20);
  doc.setTextColor(15, 23, 42);
  doc.text(farm?.name ?? 'Farm map', margin, 16);
  doc.setFontSize(10);
  doc.setTextColor(100, 116, 139);
  doc.text(new Date().toLocaleString(), pageW - margin, 16, {
    align: 'right',
  });

  // Map image — fit current view into the left box, preserving aspect.
  const boxX = margin;
  const boxY = 22;
  const boxW = pageW - margin * 2 - colW - 6;
  const boxH = pageH - boxY - margin;
  const canvas = map.getCanvas();
  const ar = canvas.width / canvas.height;
  let w = boxW;
  let h = w / ar;
  if (h > boxH) {
    h = boxH;
    w = h * ar;
  }
  doc.addImage(img, 'PNG', boxX, boxY, w, h);
  doc.setDrawColor(203, 213, 225);
  doc.rect(boxX, boxY, w, h);

  // Right column: counts + per-feature list with colour swatches.
  let x = pageW - margin - colW;
  let y = 26;
  const line = (
    label: string,
    color: string | undefined,
    indent = 0,
  ) => {
    if (y > pageH - margin) return;
    if (color) {
      const [r, g, b] = hexToRgb(color);
      doc.setFillColor(r, g, b);
      doc.circle(x + indent + 1.5, y - 1.5, 1.5, 'F');
    }
    doc.setTextColor(15, 23, 42);
    doc.text(label, x + indent + (color ? 5 : 0), y);
    y += 6;
  };
  const heading = (t: string) => {
    y += 2;
    doc.setFontSize(12);
    doc.setTextColor(13, 118, 110);
    doc.text(t, x, y);
    y += 6;
    doc.setFontSize(9);
  };

  doc.setFontSize(9);
  heading(`Paddocks (${paddocks.features.length})`);
  for (const f of paddocks.features) {
    line(
      String(f.properties.name ?? 'Unnamed'),
      typeof f.properties.color === 'string' ? f.properties.color : '#22d3ee',
    );
  }
  heading(`Poly runs (${polyRuns.features.length})`);
  for (const f of polyRuns.features) {
    line(
      String(f.properties.name ?? 'Unnamed'),
      typeof f.properties.color === 'string' ? f.properties.color : '#f97316',
    );
  }
  heading(`Points (${features.features.length})`);
  for (const f of features.features) {
    const type = String(f.properties.type ?? 'other');
    line(
      `${String(f.properties.name ?? type)}  ·  ${type}`,
      typeof f.properties.color === 'string'
        ? f.properties.color
        : (FEATURE_COLORS[type] ?? '#38bdf8'),
    );
  }

  const safe = (farm?.name ?? 'farm').replace(/[^a-z0-9-_]+/gi, '_');
  doc.save(`${safe}_map.pdf`);
}
