import express from 'express';
import cors from 'cors';
import { pathToFileURL } from 'node:url';
import { farmsRouter } from './routes/farms.js';
import { paddocksRouter } from './routes/paddocks.js';
import { polyRunsRouter } from './routes/polyRuns.js';
import { featuresRouter } from './routes/features.js';
import { photosRouter } from './routes/photos.js';
import { importRouter } from './routes/import.js';
import { errorHandler, requireToken } from './middleware/index.js';

export const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Auth gate: mutations require the write token; reads require a read token
// only when one is configured. No-op (open mode) when neither is set.
app.use(requireToken);

app.use('/api/farms', farmsRouter);
app.use('/api/farms/:farmId/paddocks', paddocksRouter);
app.use('/api/farms/:farmId/poly-runs', polyRunsRouter);
app.use('/api/farms/:farmId/features', featuresRouter);
app.use('/api/photos', photosRouter);
app.use('/api/import', importRouter);

app.use(errorHandler);

// Only bind a port when run directly (not when imported by tests).
const isMain =
  import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

if (isMain) {
  const writeToken = process.env.API_WRITE_TOKEN || process.env.API_TOKEN;
  const readToken = process.env.API_READ_TOKEN;
  if (!writeToken && !readToken) {
    console.warn(
      '[api] no API tokens set — auth gate DISABLED (open mode: reads AND writes are public)',
    );
  } else {
    console.log(
      `[api] auth gate: writes ${writeToken ? 'REQUIRE a token' : 'OPEN (no write token)'}; ` +
        `reads ${readToken ? 'REQUIRE a token' : 'OPEN'}`,
    );
  }
  const port = Number(process.env.API_PORT ?? 3001);
  app.listen(port, () => {
    console.log(`[api] listening on :${port}`);
  });
}
