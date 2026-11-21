<!-- Source: OWASP Application Security Verification Standard, L1 baseline -->

# Security baseline checklist

Every box is either ticked with its evidence, marked `N/A — <reason>`, or names the ticket that
will close it. **PT33** = user accounts and per-farm authorization; **PT35** = honest errors (done);
**PT43** = the remaining baseline gaps found by this pass (security headers, rate limiting,
dependency scanning, upload type check, audit trail, backups + restore test, token rotation). Reviewed 2026-10-21 (PT37)
against the code and the live site's response headers. **PT43 pass 2026-11-21** (branch `pt43`): the code items are
closed with tests; backups and rotation are written up in [operations.md](operations.md) as **Max / ops** jobs and
stay unticked until the first logged run.

Context that decides most of the first two sections: **there are no user accounts yet.** Access is
a deployment-wide bearer token (read tier optional, write tier required in production); see
[`api.md`](../technical/api.md#authentication).

## Authentication

- [ ] Passwords are hashed with a strong adaptive algorithm (bcrypt, argon2) — N/A today (no passwords, a token gate); PT33
- [ ] Minimum password length enforced (8+ characters) — PT33
- [ ] Breached password checking or dictionary check in place — PT33
- [ ] 2FA/MFA supported for all user accounts — PT33
- [x] Account lockout or rate limiting after repeated failed login attempts — PT43: 10 401s for the same credential from one IP in 60 s → that credential gets 429 for the rest of the window (keyed on IP + a hash of the credential, so a stale token on one device does not lock out the others behind the same farm wifi); 20 distinct failing credentials from one IP (a brute force) → credentials not recently proven from that IP get 429 (`api/src/middleware/rateLimit.ts`, `api/test/rateLimit.test.ts`). `/api/auth/*` is exempt so a stale session can always sign in again. Per function instance, not fleet-wide (documented)
- [ ] Password reset uses a time-limited, single-use token — PT33
- [x] Authentication credentials are never logged or exposed in URLs — the token travels only in the `Authorization` header; `accessLog` logs method, route shape, status and timing, not headers

## Authorization and access control

- [ ] Every API endpoint enforces authorization checks — partial: every route except `/api/health` passes `requireToken`, but there is no per-farm authorization; PT33
- [ ] Role-based access control (RBAC) is implemented and tested — two tiers (read/write token) are implemented and tested (`api/test/authGate.test.ts`); real roles are PT33
- [ ] Tenant isolation enforced at the data layer (users cannot access other tenants' data) — PT33 (anyone with the read tier, or with reads open, sees every farm)
- [x] Default-deny: access is denied unless explicitly granted — for writes: production refuses every write when no write token is configured (PT23, 503). Reads are open by design unless `API_READ_TOKEN` is set
- [ ] Admin functions are restricted to admin roles only — N/A: there are no admin functions in the app; migrations run outside it with a separate DDL role (PT30)

## Session management

- [ ] Session tokens are generated with sufficient entropy — N/A today (no sessions; static bearer tokens chosen by the operator); PT33
- [ ] Sessions expire after a reasonable idle timeout — PT33 (the static token never expires)
- [ ] Session tokens are invalidated on logout — PT33
- [ ] Session fixation is prevented (new token on login) — PT33
- [ ] Cookies use Secure, HttpOnly, and SameSite attributes — N/A: the app sets no cookies

## Input validation and output encoding

- [x] All user input is validated on the server side — Zod on every body, `?bbox=` and upload field; geometry rules in `api/src/lib/geojson.ts` (PT41/PT42)
- [x] Output is context-aware encoded to prevent XSS — React escapes all rendered text; no `dangerouslySetInnerHTML` in `web/src` (checked 2026-10-21)
- [x] Parameterized queries or ORM used to prevent SQL injection — every query goes through `query(sql, params)` with `$n` placeholders; the one composed fragment (`bboxPredicate`) binds its numbers as parameters
- [x] File uploads are validated (type, size, content) and stored safely — size (4 MB, 413); type by multer `fileFilter` and content by magic bytes (JPEG/PNG/WebP/HEIC-HEIF, else 415; `api/src/lib/imageType.ts`, PT43); stored in a private bucket under a server-chosen uuid name whose extension and content type now come from the sniffed bytes, never the client's filename
- [x] URL redirects are validated against an allowlist — the only redirect is `GET /api/photos/file/:id` → a signed URL the server builds for its own bucket; no redirect takes a URL from the request

## Cryptography

- [x] Data at rest is encrypted where required — Supabase encrypts its Postgres and Storage at rest (platform default)
- [x] Data in transit uses TLS 1.2+ — the site is HTTPS-only on Vercel (HTTP answers 308 to HTTPS); API → database uses TLS (`PGSSL=true`)
- [x] No hardcoded secrets, keys, or credentials in source code — `git grep` for tokens, keys and DSNs with passwords finds only placeholders (2026-10-21); `.env` has never been committed
- [x] Secrets are managed via environment variables or a secrets manager — Vercel project env vars; `.env` locally (gitignored)
- [ ] Cryptographic keys are rotated on a defined schedule — schedule and exact steps written (PT43, [operations.md §2](operations.md#2-secret-rotation): API tokens 90 days, session secret and `poly_app` password 180 days); **Max / ops**: tick once the first rotation is logged there

## Error handling and logging

- [x] Error responses do not leak internal details (stack traces, SQL, paths) — PT35: unanticipated errors return a generic sentence + request id; Postgres text never reaches the caller, including in import reports (PT41)
- [x] All authentication and authorization failures are logged — PT43: every 401/403 writes a distinct `{"msg":"security","event":"auth.failure"|"auth.forbidden"}` line with route shape, request id and client IP, never the credential (`createSecurityLog`, `api/test/securityLog.test.ts`); throttling writes `event: rate.limited`
- [x] Sensitive actions (role changes, data exports, deletions) have an audit trail — PT43: every successful DELETE (farms, paddocks, poly runs, features, photos, farm members) writes an `{"msg":"audit","event":"delete"}` line with the exact path and the actor, and every role grant/change (`POST …/members`, an upsert) an `event: member.grant` line naming member, role and actor (`api/test/securityLog.test.ts`). Exports are built in the browser from ordinary GETs, so there is no server event to audit
- [x] Logs do not contain sensitive data (passwords, tokens, PII) — logs carry ids, route shapes, statuses and SQLSTATE codes; headers and bodies are not logged
- [x] Centralized logging is in place for production — Vercel's function logs hold every JSON log line, keyed by `x-request-id`; `/api/health` summarises recent errors

## Data protection

- [x] PII is identified and handled according to policy — the only personal data is the free-text `farms.owner` and photo locations; EXIF is stripped from photos before upload (PT26), the location kept deliberately as a separate field
- [ ] Data retention policy is defined and enforced — N/A: single-operator tool with no third-party user data yet; becomes real with accounts (PT33)
- [x] User data can be exported and deleted on request — GeoJSON export of a whole farm; deleting a farm cascades its paddocks, poly runs and features (photos: see data-model.md)
- [ ] Backups are encrypted and tested for restoration — `scripts/backup_poly_schema.sh` (PT30) takes a verified `poly` dump; the restore drill into a throwaway PostGIS is written step by step (PT43, [operations.md §1](operations.md#1-backup-and-restore-drill-poly-schema)); **Max / ops**: tick once the first drill is logged there. Photo bytes in Storage are not in the dump: PT43-fu5
- [x] Database access is restricted to application service accounts — the app connects as `poly_app`, scoped to the `poly` schema with no DDL rights; verified permission-denied on `public.*` and `auth.*` (DEPLOY.md)

## Communication security

- [x] TLS is enforced on all external endpoints — Vercel serves HTTPS only; plain HTTP is redirected (308)
- [x] HSTS header is set with a reasonable max-age — `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` (live, 2026-10-21)
- [ ] Internal service-to-service communication is authenticated — N/A: there is one service; its database connection is authenticated (role + password over TLS)
- [x] Certificate validity is monitored — certificates are issued and renewed by Vercel and Supabase automatically

## Dependency management

- [x] Dependency scanning (SCA) runs in CI — PT43: `scripts/audit-gate.mjs` runs `npm audit` in `api/` and `web/` in `ci.yml` and fails on any high/critical not on the reviewed allowlist (`scripts/audit-allowlist.json`: reason, ticket, review-by date); `.github/dependabot.yml` proposes updates weekly
- [x] Dependencies are pinned and updated on a defined cadence — pinned by `package-lock.json` in `api/` and `web/`, and MapLibre deliberately held at v3; the update cadence is part of PT43's scanning step
- [ ] No known critical/high CVEs in production dependencies — measured 2026-11-21 after a non-breaking `npm audit fix`: api `zod` (high, fix is zod 4: PT43-fu1); web `jspdf` (10 high/critical, fix is jspdf 4: PT43-fu2), `maplibre-gl` (critical, Popup sanitizer the app does not use; fix is v6: PT43-fu3). Each allowlisted with its reason until 2027-02-28
- [x] Third-party code is reviewed before adoption — every dependency added is named in its ticket's plan and reviewed with the diff

## Business logic

- [x] Rate limiting is applied to public and sensitive endpoints — PT43: writes 120/min per IP and auth failures (above), 429 + `Retry-After`; per function instance on Vercel (no shared store, by choice). The web client already treats 429 as retryable, so queued offline edits wait rather than drop
- [ ] Abuse prevention measures are in place (e.g., CAPTCHAs, honeypots) — N/A: no public sign-up or anonymous write path (writes need the token)
- [x] Business-critical flows have server-side validation (not client-only) — the geometry rules run on the server and the client, from one fixture set; imports validate every feature
- [x] Idempotency is enforced where needed (payments, state transitions) — photo uploads dedupe on `client_id` (PT38); edits use `If-Match` versions (PT18-fu1); offline replays carry the version they were made on

## Deployment and configuration

- [x] Production environment is hardened (debug mode off, default credentials removed) — `NODE_ENV=production` on Vercel; writes fail closed without a token (PT23); the local `poly:poly` credentials exist only in docker-compose
- [x] Secrets are not committed to version control — `.env*` is gitignored and absent from history
- [x] Environment separation is enforced (dev/staging/prod) — local docker-compose has its own database; production is the only deployed environment (no staging, by choice)
- [x] Security headers are set (CSP, X-Content-Type-Options, X-Frame-Options) — PT43: the SPA's CSP + nosniff + DENY + Referrer-Policy from `vercel.json` on every non-`/api` path, its hosts pinned to the code by `web/src/lib/csp.test.ts` and loaded clean in Chromium for all three basemaps; the API sends its own deny-all CSP (`securityHeaders.ts`). Live check after deploy: [operations.md §3](operations.md#3-after-a-deploy-that-changes-headers-pt43)
- [x] Unnecessary services, ports, and features are disabled — production is one static site + one function; no open ports beyond Vercel's HTTPS
