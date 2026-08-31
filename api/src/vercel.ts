// PT21 — serverless entry point.
//
// The Express app is already shaped for this: `src/index.ts` exports `app` and
// only calls listen() when it is the process entry point, so importing it here
// gives a request handler and starts no server. Everything under /api/* is
// routed to this one function by vercel.json — one function, not one per route,
// so the SPA and the API share an origin and there is no VITE_API_BASE to get
// wrong and no CORS policy to maintain.
//
// Kept inside src/ deliberately: tsconfig sets rootDir=src, and an entry point
// outside it fails to compile.
import { app } from './index.js';

export default app;
