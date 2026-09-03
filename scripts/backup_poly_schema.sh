#!/usr/bin/env bash
# PT30 — dump the `poly` schema, and prove the dump is readable before publishing it.
#
# Why this exists: this database has already been destroyed once. Render's free
# Postgres deleted it (PT22) and there was no dump anywhere in the repo or in
# scripts/, so the schema was rebuilt from db/init and the DATA WAS NOT
# RECOVERED — measured 2026-09-03, all five poly tables are still at 0 rows.
#
# So the honest framing: today this protects an empty schema. It exists so that
# the first time there IS data, the backup already works and has been run, rather
# than being written in the hour after it was needed.
#
# ⚠️ Dumps ONLY the `poly` schema. This is a SHARED Supabase project —
# `public` is Our_Menu's live data and `cortana` is Cortana's. A whole-database
# dump would pull two other apps' data into this repo's backup directory, which
# is both wrong and a privacy problem.
#
# pg_dump is not required on the host: if it is absent, this falls back to
# running it inside a postgres container, matching the server's major version.
#
# Usage:
#   POLY_TRACKER_DATABASE_URL="postgres://…" scripts/backup_poly_schema.sh [outdir]
set -euo pipefail

DSN="${POLY_TRACKER_DATABASE_URL:-${DATABASE_URL:-}}"
if [ -z "$DSN" ]; then
  echo "POLY_TRACKER_DATABASE_URL (or DATABASE_URL) is not set." >&2
  exit 2
fi
OUT_DIR="${1:-backups}"
mkdir -p "$OUT_DIR"
STAMP=$(date +%Y%m%d_%H%M%S)
OUT="$OUT_DIR/poly_schema_${STAMP}.sql"

# --schema=poly, and no --clean/--create: a restore must never be able to drop
# something. --no-owner/--no-privileges because the restoring role differs.
PGDUMP_ARGS=(--schema=poly --no-owner --no-privileges --format=plain)

if command -v pg_dump >/dev/null 2>&1; then
  echo "→ using host pg_dump ($(pg_dump --version))"
  pg_dump "${PGDUMP_ARGS[@]}" --dbname="$DSN" > "$OUT.partial"
elif command -v docker >/dev/null 2>&1; then
  # Server major version, so pg_dump is never older than the server it reads.
  # An older pg_dump refuses outright, which is better than a subtly partial
  # dump — but there is no reason to accept the failure when the version is
  # knowable.
  MAJOR=$(docker run --rm postgres:16 psql "$DSN" -At -c 'show server_version_num' 2>/dev/null | cut -c1-2 || echo 16)
  IMAGE="postgres:${MAJOR}"
  echo "→ host pg_dump absent; using ${IMAGE} in docker"
  docker run --rm -i "$IMAGE" pg_dump "${PGDUMP_ARGS[@]}" --dbname="$DSN" > "$OUT.partial"
else
  echo "neither pg_dump nor docker is available — cannot take a dump." >&2
  exit 3
fi

# ── Prove it before publishing it ───────────────────────────────────────────
# A 0-byte or truncated dump next to real ones is worse than no dump: it is the
# one someone reaches for. backup_pilot.sh emitted an empty file nightly for 26
# days on another project and nothing noticed.
if [ ! -s "$OUT.partial" ]; then
  rm -f "$OUT.partial"
  echo "FAILED: pg_dump produced a 0-byte file." >&2
  exit 1
fi
if ! grep -q 'PostgreSQL database dump complete' "$OUT.partial"; then
  rm -f "$OUT.partial"
  echo "FAILED: the dump has no completion marker — it is truncated." >&2
  exit 1
fi
TABLES=$(grep -c '^CREATE TABLE' "$OUT.partial" || true)
if [ "${TABLES:-0}" -lt 1 ]; then
  rm -f "$OUT.partial"
  echo "FAILED: the dump defines 0 tables. Wrong schema, or the wrong database." >&2
  exit 1
fi

mv "$OUT.partial" "$OUT"
COPIES=$(grep -c '^COPY ' "$OUT" || true)
echo "✓ $OUT"
echo "  $(wc -c < "$OUT") bytes · ${TABLES} CREATE TABLE · ${COPIES} COPY block(s)"
if [ "${COPIES:-0}" -eq 0 ]; then
  echo "  NOTE: 0 COPY blocks — the schema currently holds no rows. Structure only."
fi
