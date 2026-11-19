import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import { useSession } from './lib/session';
import './index.css';
// PT32 — the MapLibre + Draw stylesheets moved to MapView.tsx, so they ship
// with the map chunk instead of blocking the first paint of every screen.

registerSW({ immediate: true });
// PT33 — learn whether per-user sign-in is on, and finish a magic-link sign-in
// if this page load is the link's landing.
void useSession.getState().load();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

// NOTE: React.StrictMode intentionally omitted. Its dev-only double-invoke
// of effects creates → destroys → recreates the MapLibre map in quick
// succession, which makes Firefox drop the WebGL context ("WebGL context
// was lost") and leaves mapbox-gl-draw bound to a dead canvas. StrictMode
// has no effect on production builds, so this is a dev-correctness fix only.
ReactDOM.createRoot(rootEl).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
);
