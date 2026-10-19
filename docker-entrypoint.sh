#!/bin/sh
# ---------------------------------------------------------------------------
# docker-entrypoint.sh — makes `docker compose up --build` fully
# self-contained: migrations + predefined plan seed run BEFORE the API
# starts serving, so the stack needs zero manual steps.
#
# Concurrency safety: two API replicas racing this entrypoint is safe —
# the migrator serializes on a session advisory lock and checksums every
# applied file, and the seed upserts the catalog idempotently
# (ON CONFLICT DO UPDATE).
# ---------------------------------------------------------------------------
set -e

echo "[entrypoint] applying database migrations…"
node dist/src/database/migrator.js up

echo "[entrypoint] seeding predefined plan catalog…"
node dist/src/scripts/seed.js

echo "[entrypoint] starting API server…"
exec node dist/src/server.js
