import express from 'express';
import cors from 'cors';
import { pathToFileURL } from 'node:url';
import { farmsRouter } from './routes/farms.js';
import { paddocksRouter } from './routes/paddocks.js';
import { polyRunsRouter } from './routes/polyRuns.js';
import { featuresRouter } from './routes/features.js';
import { photosRouter } from './routes/photos.js';
import { errorHandler } from './middleware/index.js';

export const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.use('/api/farms', farmsRouter);
app.use('/api/farms/:farmId/paddocks', paddocksRouter);
app.use('/api/farms/:farmId/poly-runs', polyRunsRouter);
app.use('/api/farms/:farmId/features', featuresRouter);
app.use('/api/photos', photosRouter);

app.use(errorHandler);

// Only bind a port when run directly (not when imported by tests).
const isMain =
  import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

if (isMain) {
  if (!process.env.API_TOKEN) {
    console.warn('[api] API_TOKEN is not set — write gate is DISABLED (open mode)');
  }
  const port = Number(process.env.API_PORT ?? 3001);
  app.listen(port, () => {
    console.log(`[api] listening on :${port}`);
  });
}
