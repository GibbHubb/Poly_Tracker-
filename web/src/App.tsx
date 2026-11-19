import { Suspense, lazy, useEffect } from 'react';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { FarmList } from './pages/FarmList';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import { startAutoSync } from './lib/sync';
import { ConflictToast } from './components/ConflictToast';
import { Toaster } from './components/Toaster';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useSession } from './lib/session';

// PT32 — the map screen (MapLibre, mapbox-gl-draw, turf, exifr) and the
// settings screen are split out of the entry chunk, so `/` paints from the
// shell alone. Both are still precached by the service worker, so offline use
// is unchanged; this only changes what has to arrive before the first paint.
const FarmMap = lazy(() => import('./pages/FarmMap').then((m) => ({ default: m.FarmMap })));
const Settings = lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })));

/** Same dark surface as the shell, so a slow chunk is a pause, not a white flash. */
function RouteFallback() {
  return (
    <div className="flex h-full items-center justify-center bg-slate-900 text-sm text-slate-400" role="status">
      Loading…
    </div>
  );
}

function StatusBadge() {
  const { online, pending } = useOnlineStatus();
  return (
    <span
      className={`rounded-full px-3 py-1 text-xs font-medium ${
        online ? 'bg-emerald-600 text-white' : 'bg-amber-500 text-white'
      }`}
    >
      {online ? 'Online' : 'Offline'}
      {pending > 0 ? ` · ${pending} pending` : ''}
    </span>
  );
}

/** PT33 — users mode with no session: say so instead of a bare 401 on every screen. */
function SignInBanner() {
  const { config, me, error, loaded } = useSession();
  if (!loaded || !config?.users_mode || (me && !error)) return null;
  return (
    <div className="border-b border-amber-700 bg-amber-900/40 px-4 py-2 text-sm text-amber-200" role="status">
      {error ? `Sign-in failed: ${error} ` : 'You are not signed in. '}
      <Link to="/settings" className="underline">
        Sign in
      </Link>
    </div>
  );
}

export default function App() {
  useEffect(() => startAutoSync(), []);
  // PT35 — keyed on the path so leaving a broken screen clears the boundary.
  const { pathname } = useLocation();

  return (
    <Routes>
      <Route
        path="*"
        element={
          <div className="flex h-full flex-col bg-slate-900 text-slate-100">
            <header className="flex items-center justify-between border-b border-slate-800 px-4 py-3 max-md:py-1">
              <Link to="/" className="text-lg font-semibold text-brand max-md:flex max-md:min-h-[44px] max-md:items-center">
                Poly Tracker
              </Link>
              <div className="flex items-center gap-3">
                <StatusBadge />
                <Link to="/settings" className="text-sm text-slate-300 max-md:-mr-2 max-md:flex max-md:min-h-[44px] max-md:min-w-[44px] max-md:items-center max-md:px-2">
                  Settings
                </Link>
              </div>
            </header>
            <SignInBanner />
            <main className="min-h-0 flex-1">
              <ErrorBoundary key={pathname}>
                <Suspense fallback={<RouteFallback />}>
                  <Routes>
                    <Route path="/" element={<FarmList />} />
                    <Route path="/farms/:farmId" element={<FarmMap />} />
                    <Route path="/settings" element={<Settings />} />
                  </Routes>
                </Suspense>
              </ErrorBoundary>
            </main>
            <ConflictToast />
            <Toaster />
          </div>
        }
      />
    </Routes>
  );
}
