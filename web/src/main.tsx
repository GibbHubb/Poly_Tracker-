import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import './index.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';

registerSW({ immediate: true });

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
