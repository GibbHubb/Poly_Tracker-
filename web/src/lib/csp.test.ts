/**
 * PT43 — the SPA's Content-Security-Policy lives in vercel.json, a long way
 * from the code that decides which hosts the page talks to. This pins the two
 * together: add a basemap or an external fetch without adding its host to the
 * CSP and this fails, instead of the map going grey in production with nothing
 * but a console error to say why.
 */
import { describe, it, expect } from 'vitest';
import { basemapConfig, type BasemapProvider } from './mapStyle';
import vercelJson from '../../../vercel.json';
import indexHtml from '../../index.html?raw';

interface Route {
  src: string;
  headers?: Record<string, string>;
}
const vercel = vercelJson as { routes: Route[] };
// Every shipped source file, as text (tests excluded). Read with node:fs, loaded
// dynamically because web has no @types/node: a `?raw` glob of the .ts files
// would make the coverage run count those modules differently.
interface NodeFs {
  readdirSync(p: string, o: { recursive: true }): string[];
  readFileSync(p: string, e: 'utf8'): string;
}
const fsModule = 'node:fs';
const fs = (await import(/* @vite-ignore */ fsModule)) as NodeFs;
const SRC_DIR = decodeURIComponent(new URL('../', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const SOURCES: Record<string, string> = Object.fromEntries(
  fs
    .readdirSync(SRC_DIR, { recursive: true })
    .map((f) => f.replace(/\\/g, '/'))
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f))
    .map((f) => [f, fs.readFileSync(SRC_DIR + f, 'utf8')]),
);
const headerRoute = vercel.routes.find((r) => r.headers?.['Content-Security-Policy']);
const csp = headerRoute?.headers?.['Content-Security-Policy'] ?? '';

/** directive → its sources. */
const directives = new Map(
  csp
    .split(';')
    .map((d) => d.trim().split(/\s+/))
    .filter((parts) => parts[0])
    .map(([name, ...sources]) => [name!, sources] as const),
);
const sources = (d: string) => directives.get(d) ?? directives.get('default-src') ?? [];

/** Does a CSP source list allow this origin? Handles exact origins and `https://*.example.com`. */
function allows(list: string[], origin: string): boolean {
  const host = new URL(origin).host;
  return list.some((s) => {
    if (s === origin) return true;
    const wild = /^https:\/\/\*\.(.+)$/.exec(s);
    return Boolean(wild && host.endsWith(`.${wild[1]}`));
  });
}

/** Every `https://host` that appears as a string literal in shipped web code. */
function originsInSource(): string[] {
  const found = new Set<string>();
  for (const text of Object.values(SOURCES)) {
    for (const m of text.matchAll(/['"`](https:\/\/[a-z0-9.-]+)/gi)) found.add(m[1]!.toLowerCase());
  }
  return [...found];
}

describe('SPA Content-Security-Policy (PT43)', () => {
  it('is set on every non-/api path, with the other three headers, and not on /api (the API sets its own)', () => {
    expect(headerRoute).toBeDefined();
    const re = new RegExp(headerRoute!.src);
    expect(re.test('/')).toBe(true);
    expect(re.test('/farms/abc')).toBe(true);
    expect(re.test('/sw.js')).toBe(true);
    expect(re.test('/api/farms')).toBe(false);
    expect(headerRoute!.headers).toMatchObject({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    });
  });

  it('lets every basemap provider’s tiles load (fetched by MapLibre and the offline tile cache, drawn as images)', () => {
    for (const provider of ['mapbox', 'esri', 'qld'] as BasemapProvider[]) {
      for (const template of basemapConfig(provider).tiles) {
        const origin = new URL(template.replace(/[{}]/g, '')).origin;
        expect(allows(sources('connect-src'), origin), `${provider} connect-src ${origin}`).toBe(true);
        expect(allows(sources('img-src'), origin), `${provider} img-src ${origin}`).toBe(true);
      }
    }
  });

  it('allows every external origin the web code names (place search, tiles, …) in connect-src', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(20); // the glob really found the source tree
    const origins = originsInSource();
    expect(origins).toContain('https://nominatim.openstreetmap.org');
    for (const origin of origins) {
      expect(allows(sources('connect-src'), origin), `connect-src is missing ${origin}`).toBe(true);
    }
  });

  it('allows Supabase (runtime-configured magic-link endpoint; signed photo URLs the API redirects to)', () => {
    expect(allows(sources('connect-src'), 'https://abcdefgh.supabase.co')).toBe(true);
    expect(allows(sources('img-src'), 'https://abcdefgh.supabase.co')).toBe(true);
  });

  it('keeps MapLibre and the photo previews working: same-origin + blob: workers, data:/blob: images', () => {
    // MapLibre's CSP build loads its worker from a same-origin file (PT32, MapView.tsx);
    // blob: stays allowed for any build that falls back to a blob worker.
    expect(sources('worker-src')).toEqual(expect.arrayContaining(["'self'", 'blob:']));
    // Photo thumbnails are object URLs (PhotoUpload.tsx); MapLibre and jsPDF use data: images.
    expect(sources('img-src')).toEqual(expect.arrayContaining(["'self'", 'data:', 'blob:']));
    // Self-hosted glyph PBFs (PT16) are fetched same-origin.
    expect(sources('connect-src')).toContain("'self'");
  });

  it('allows no inline or eval’d script, no plugins, and no framing', () => {
    expect(sources('script-src')).toEqual(["'self'"]);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
    expect(sources('object-src')).toEqual(["'none'"]);
    expect(sources('frame-ancestors')).toEqual(["'none'"]);
  });

  it('index.html has no inline script for the policy to block', () => {
    const scripts = [...indexHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attrs, body] of scripts) {
      expect(attrs).toMatch(/\bsrc=/);
      expect(body!.trim()).toBe('');
    }
  });
});
