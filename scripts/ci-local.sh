#!/usr/bin/env bash
# scripts/ci-local.sh (WP-QA01): the same gates .github/workflows/ci.yml runs, on this machine.
#
# CI's "postgres" job proves db:migrate, db:wall and db:parity against a postgres:16 service
# container. There is no such container here, so scripts/local-preview.sh plays that part: it
# brings up a real Homebrew Postgres 16, runs db-migrate.ts as the owner and sets app_user's
# password, exactly as the CI job does against its own container. db:wall and db:parity then
# run against that same real database, not the pg-mem fallback.
#
# Needs: HEAVY (memory-heavy steps go through ~/Documents/Claude/bin/heavy when present, same
# as local-preview.sh's own build step) and Postgres 16 from Homebrew (postgresql@16).
set -euo pipefail

PRODUCT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PRODUCT_DIR"
HEAVY="${HEAVY:-$HOME/Documents/Claude/bin/heavy}"
[ -x "$HEAVY" ] || HEAVY=""

say() { printf 'ci-local: %s\n' "$*"; }

say "typecheck"
${HEAVY:+$HEAVY} npx tsc --noEmit

say "test"
${HEAVY:+$HEAVY} npm test

say "build"
${HEAVY:+$HEAVY} npm run build

say "eval"
npm run eval

say "local preview up (real Postgres 16, migrate, app on 127.0.0.1:3107)"
bash scripts/local-preview.sh up
cleanup() { bash scripts/local-preview.sh down; }
trap cleanup EXIT

PREVIEW_HOME="${PREVIEW_HOME:-$HOME/dev/tearline-preview}"
PG_PORT="${PREVIEW_PG_PORT:-54329}"
# shellcheck disable=SC1090
. "$PREVIEW_HOME/env.sh"
export APP_DATABASE_URL="postgres://app_user:${APP_USER_PASSWORD}@127.0.0.1:${PG_PORT}/tearline"

say "db:wall"
npm run db:wall

say "db:parity"
npm run db:parity

say "playwright install (chromium only)"
npx playwright install chromium

say "playwright test"
npx playwright test

say "all gates green"
