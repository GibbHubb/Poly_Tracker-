import { useEffect } from 'react';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { FarmList } from './pages/FarmList';
import { FarmMap } from './pages/FarmMap';
import { Settings } from './pages/Settings';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import { startAutoSync } from './lib/sync';
import { ConflictToast } from './components/ConflictToast';
import { Toaster } from './components/Toaster';
import { ErrorBoundary } from './components/ErrorBoundary';

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
            <header className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
              <Link to="/" className="text-lg font-semibold text-brand">
                Poly Tracker
              </Link>
              <div className="flex items-center gap-3">
                <StatusBadge />
                <Link to="/settings" className="text-sm text-slate-300">
                  Settings
                </Link>
              </div>
            </header>
            <main className="min-h-0 flex-1">
              <ErrorBoundary key={pathname}>
                <Routes>
                  <Route path="/" element={<FarmList />} />
                  <Route path="/farms/:farmId" element={<FarmMap />} />
                  <Route path="/settings" element={<Settings />} />
                </Routes>
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
