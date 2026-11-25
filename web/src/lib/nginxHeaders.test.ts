/**
 * PT48 — the self-hosted path (docker-compose.prod.yml → web/nginx.prod.conf) must send the
 * same security headers as Vercel (vercel.json, PT43). PT43 added them to vercel.json only and
 * nothing noticed nginx had none; this pins the two together. Add, drop or change a header in
 * vercel.json and this fails until nginx matches.
 *
 * The parse is deliberately small: nginx.prod.conf is one server block with flat locations.
 */
import { describe, it, expect } from 'vitest';
import vercelJson from '../../../vercel.json';
import nginxConf from '../../nginx.prod.conf?raw';

interface Route {
  src: string;
  headers?: Record<string, string>;
}
const routes = (vercelJson as { routes: Route[] }).routes;
const spaHeaders = routes.find((r) => r.headers?.['Content-Security-Policy'])?.headers ?? {};
const swHeaders = routes.find((r) => r.src === '/sw.js')?.headers ?? {};

interface AddHeader {
  name: string;
  value: string;
  always: boolean;
}

/** `add_header Name "value" [always];` lines in a block of text. */
function addHeaders(text: string): AddHeader[] {
  return [...text.matchAll(/^\s*add_header\s+(\S+)\s+"([^"]*)"(\s+always)?\s*;/gm)].map((m) => ({
    name: m[1]!,
    value: m[2]!,
    always: Boolean(m[3]),
  }));
}

const code = nginxConf.replace(/#.*$/gm, ''); // comments out, so prose cannot satisfy a check
const locations = new Map(
  [...code.matchAll(/location\s+([^{]+?)\s*\{([^}]*)\}/g)].map((m) => [m[1]!.trim(), m[2]!] as const),
);
const outsideLocations = code.replace(/location\s+[^{]+\{[^}]*\}/g, '');

const asRecord = (hs: AddHeader[]) => Object.fromEntries(hs.map((h) => [h.name, h.value]));

describe('self-hosted nginx security headers match vercel.json (PT48)', () => {
  it('reads the routes it compares (guards against a vacuous pass)', () => {
    expect(Object.keys(spaHeaders)).toEqual(
      expect.arrayContaining(['Content-Security-Policy', 'X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy']),
    );
    expect(swHeaders).toEqual({ 'Cache-Control': 'no-cache' });
    expect([...locations.keys()].sort()).toEqual(['/', '/api/', '= /sw.js']);
  });

  it('the SPA fallback location sends exactly vercel.json’s SPA headers, each `always`', () => {
    const hs = addHeaders(locations.get('/')!);
    expect(asRecord(hs)).toEqual(spaHeaders);
    expect(hs.every((h) => h.always)).toBe(true);
  });

  it('/sw.js sends the SPA headers too, plus no-cache (an own add_header drops inherited ones)', () => {
    const hs = addHeaders(locations.get('= /sw.js')!);
    expect(asRecord(hs)).toEqual({ ...spaHeaders, ...swHeaders });
    expect(hs.every((h) => h.always)).toBe(true);
  });

  it('/api/ gets none: the API sends its own deny-all CSP, never both on one response', () => {
    expect(addHeaders(locations.get('/api/')!)).toEqual([]);
  });

  it('no server-level add_header, which /api/ would inherit and the SPA locations would silently drop', () => {
    expect(addHeaders(outsideLocations)).toEqual([]);
  });

  it('no header value holds a double quote or a `$` that nginx would cut short or expand', () => {
    for (const v of [...Object.values(spaHeaders), ...Object.values(swHeaders)]) {
      expect(v).not.toMatch(/["$]/);
    }
  });
});
