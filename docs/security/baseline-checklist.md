<!-- Source: OWASP Application Security Verification Standard, L1 baseline -->

# Security baseline checklist

Every box is either ticked with its evidence, marked `N/A — <reason>`, or names the ticket that
will close it. **PT33** = user accounts and per-farm authorization; **PT35** = honest errors (done);
**PT43** = the remaining baseline gaps found by this pass (security headers, rate limiting,
dependency scanning, upload type check, audit trail, backups + restore test, token rotation). Reviewed 2026-10-21 (PT37)
against the code and the live site's response headers.

Context that decides most of the first two sections: **there are no user accounts yet.** Access is
a deployment-wide bearer token (read tier optional, write tier required in production); see
[`api.md`](../technical/api.md#authentication).

## Authentication

- [ ] Passwords are hashed with a strong adaptive algorithm (bcrypt, argon2) — N/A today (no passwords, a token gate); PT33
- [ ] Minimum password length enforced (8+ characters) — PT33
- [ ] Breached password checking or dictionary check in place — PT33
- [ ] 2FA/MFA supported for all user accounts — PT33
- [ ] Account lockout or rate limiting after repeated failed login attempts — PT33 (logins); PT43 (rate limiting the token gate)
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
- [ ] File uploads are validated (type, size, content) and stored safely — size yes (4 MB, 413); stored safely yes (private bucket, server-chosen uuid name); **type and content are not checked server-side** (no multer `fileFilter`); PT43
- [x] URL redirects are validated against an allowlist — the only redirect is `GET /api/photos/file/:id` → a signed URL the server builds for its own bucket; no redirect takes a URL from the request

## Cryptography

- [x] Data at rest is encrypted where required — Supabase encrypts its Postgres and Storage at rest (platform default)
- [x] Data in transit uses TLS 1.2+ — the site is HTTPS-only on Vercel (HTTP answers 308 to HTTPS); API → database uses TLS (`PGSSL=true`)
- [x] No hardcoded secrets, keys, or credentials in source code — `git grep` for tokens, keys and DSNs with passwords finds only placeholders (2026-10-21); `.env` has never been committed
- [x] Secrets are managed via environment variables or a secrets manager — Vercel project env vars; `.env` locally (gitignored)
- [ ] Cryptographic keys are rotated on a defined schedule — no schedule for the operator-chosen API tokens or the DB password; PT43

## Error handling and logging

- [x] Error responses do not leak internal details (stack traces, SQL, paths) — PT35: unanticipated errors return a generic sentence + request id; Postgres text never reaches the caller, including in import reports (PT41)
- [ ] All authentication and authorization failures are logged — 401s appear in the access log by status, but not as a distinct security event; PT43
- [ ] Sensitive actions (role changes, data exports, deletions) have an audit trail — no audit trail of deletes; PT43
- [x] Logs do not contain sensitive data (passwords, tokens, PII) — logs carry ids, route shapes, statuses and SQLSTATE codes; headers and bodies are not logged
- [x] Centralized logging is in place for production — Vercel's function logs hold every JSON log line, keyed by `x-request-id`; `/api/health` summarises recent errors

## Data protection

- [x] PII is identified and handled according to policy — the only personal data is the free-text `farms.owner` and photo locations; EXIF is stripped from photos before upload (PT26), the location kept deliberately as a separate field
- [ ] Data retention policy is defined and enforced — N/A: single-operator tool with no third-party user data yet; becomes real with accounts (PT33)
- [x] User data can be exported and deleted on request — GeoJSON export of a whole farm; deleting a farm cascades its paddocks, poly runs and features (photos: see data-model.md)
- [ ] Backups are encrypted and tested for restoration — the free Supabase plan is not relied on for backups and no restore has been tested; PT43 (a scheduled `pg_dump` of the `poly` schema + one proven restore)
- [x] Database access is restricted to application service accounts — the app connects as `poly_app`, scoped to the `poly` schema with no DDL rights; verified permission-denied on `public.*` and `auth.*` (DEPLOY.md)

## Communication security

- [x] TLS is enforced on all external endpoints — Vercel serves HTTPS only; plain HTTP is redirected (308)
- [x] HSTS header is set with a reasonable max-age — `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` (live, 2026-10-21)
- [ ] Internal service-to-service communication is authenticated — N/A: there is one service; its database connection is authenticated (role + password over TLS)
- [x] Certificate validity is monitored — certificates are issued and renewed by Vercel and Supabase automatically

## Dependency management

- [ ] Dependency scanning (SCA) runs in CI — `ci.yml` has no `npm audit` / Dependabot step; PT43
- [x] Dependencies are pinned and updated on a defined cadence — pinned by `package-lock.json` in `api/` and `web/`, and MapLibre deliberately held at v3; the update cadence is part of PT43's scanning step
- [ ] No known critical/high CVEs in production dependencies — not measured until SCA runs; PT43
- [x] Third-party code is reviewed before adoption — every dependency added is named in its ticket's plan and reviewed with the diff

## Business logic

- [ ] Rate limiting is applied to public and sensitive endpoints — none; PT43
- [ ] Abuse prevention measures are in place (e.g., CAPTCHAs, honeypots) — N/A: no public sign-up or anonymous write path (writes need the token)
- [x] Business-critical flows have server-side validation (not client-only) — the geometry rules run on the server and the client, from one fixture set; imports validate every feature
- [x] Idempotency is enforced where needed (payments, state transitions) — photo uploads dedupe on `client_id` (PT38); edits use `If-Match` versions (PT18-fu1); offline replays carry the version they were made on

## Deployment and configuration

- [x] Production environment is hardened (debug mode off, default credentials removed) — `NODE_ENV=production` on Vercel; writes fail closed without a token (PT23); the local `poly:poly` credentials exist only in docker-compose
- [x] Secrets are not committed to version control — `.env*` is gitignored and absent from history
- [x] Environment separation is enforced (dev/staging/prod) — local docker-compose has its own database; production is the only deployed environment (no staging, by choice)
- [ ] Security headers are set (CSP, X-Content-Type-Options, X-Frame-Options) — none of the three is sent (live, 2026-10-21); PT43
- [x] Unnecessary services, ports, and features are disabled — production is one static site + one function; no open ports beyond Vercel's HTTPS
