import { Router } from 'express';
import { query } from '../db.js';
import { asyncHandler, HttpError } from '../middleware/index.js';
import { renderFarmPdf } from '../lib/pdfRenderer.js';

// mergeParams: mounted at /api/farms/:farmId/export-pdf
export const pdfRouter = Router({ mergeParams: true });

// The web container serves the print-styled SPA route. Override in compose if
// the web service is reachable under a different name/port.
const WEB_INTERNAL_BASE = process.env.WEB_INTERNAL_BASE ?? 'http://web:5173';

pdfRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const farmId = req.params.farmId;
    const { rows } = await query<{ name: string }>(
      'SELECT name FROM farms WHERE id = $1',
      [farmId],
    );
    if (rows.length === 0) throw new HttpError(404, 'Farm not found');

    const pdf = await renderFarmPdf({
      printUrl: `${WEB_INTERNAL_BASE}/print/${farmId}`,
    });

    const safeName = rows[0]!.name.replace(/[^a-z0-9-_]+/gi, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeName}_map.pdf"`,
    );
    res.send(pdf);
  }),
);
