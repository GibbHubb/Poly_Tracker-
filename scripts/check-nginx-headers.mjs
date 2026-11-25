#!/usr/bin/env node
// PT48 — ask a RUNNING self-hosted nginx (web/nginx.prod.conf) for its headers and compare them
// with vercel.json's. web/src/lib/nginxHeaders.test.ts compares the config text; this proves
// nginx actually sends it (a typo nginx accepts, an inheritance surprise, `always` on errors).
//
//   node scripts/check-nginx-headers.mjs http://localhost:8080
//
// CI runs it against nginx:1.27-alpine with the real config and a stub html root, where /api/
// has no upstream and answers 502: that is the error path `always` exists for.
import { readFileSync } from 'node:fs';

const base = (process.argv[2] ?? 'http://localhost:8080').replace(/\/+$/, '');
const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
const spa = vercel.routes.find((r) => r.headers?.['Content-Security-Policy'])?.headers;
const sw = vercel.routes.find((r) => r.src === '/sw.js')?.headers;
if (!spa || !sw) {
  console.error('vercel.json has no SPA header route or no /sw.js route; nothing to compare.');
  process.exit(2);
}

const failures = [];
async function expectHeaders(path, want, forbid = []) {
  const res = await fetch(base + path, { redirect: 'manual' });
  for (const [name, value] of Object.entries(want)) {
    const got = res.headers.get(name);
    if (got !== value) failures.push(`${path} (${res.status}): ${name} = ${JSON.stringify(got)}, want ${JSON.stringify(value)}`);
  }
  for (const name of forbid) {
    if (res.headers.has(name)) failures.push(`${path} (${res.status}): must not send ${name}`);
  }
  console.log(`${path} → ${res.status}`);
}

await expectHeaders('/', spa);
await expectHeaders('/farms/abc', spa); // SPA deep link, served by the index.html fallback
await expectHeaders('/sw.js', { ...spa, ...sw });
await expectHeaders('/api/health', {}, ['Content-Security-Policy', 'X-Frame-Options']);

if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ nginx sends vercel.json's ${Object.keys(spa).length} SPA headers on / and /farms/abc, plus no-cache on /sw.js, and none on /api/`);
