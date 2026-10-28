#!/usr/bin/env bash
# e2e/security/setup.sh (WP-QA06)
# Prepares the local preview for e2e/security/probe.ts: two invited users in two tenants
# (qa06-a, qa06-b), and a secret sheet plus a run that belong to tenant A only.
# Local preview only. It refuses any database that is not on 127.0.0.1.
#
#   PREVIEW_HOME=~/dev/tearline-preview-qa06 PREVIEW_PG_PORT=54346 PREVIEW_APP_PORT=3126 \
#     bash e2e/security/setup.sh            # prints the env line for probe.ts
set -euo pipefail
cd "$(dirname "$0")/../.."
PREVIEW_HOME="${PREVIEW_HOME:?set PREVIEW_HOME}"
PG_PORT="${PREVIEW_PG_PORT:?}"
APP_PORT="${PREVIEW_APP_PORT:?}"
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@16/bin}"
. "$PREVIEW_HOME/env.sh"
OWNER_URL="postgres://neondb_owner:${OWNER_PASSWORD}@127.0.0.1:${PG_PORT}/tearline"
BASE="http://127.0.0.1:${APP_PORT}"
MARK="QA06-SECRET-A"
sup() { "$PGBIN/psql" -h "$PREVIEW_HOME" -p "$PG_PORT" -U postgres -d tearline -v ON_ERROR_STOP=1 -qAt "$@"; }

A_EMAIL="a-qa06@preview.local"; B_EMAIL="b-qa06@preview.local"
A_PASS="$(openssl rand -hex 12)"; B_PASS="$(openssl rand -hex 12)"

make_user() { # tenant email password
  local out token
  if [ "$(sup -c "select 1 from app_user where email='$2'")" = "1" ]; then
    sup -c "delete from app_user where email='$2'"
  fi
  out="$(DATABASE_URL="$OWNER_URL" npx tsx scripts/add-user.ts --tenant "$1" --create-tenant --email "$2")"
  token="$(printf '%s\n' "$out" | grep -o 'invite=[^ ]*' | head -1 | cut -d= -f2)"
  [ -n "$token" ] || { echo "no invite token in: $out" >&2; exit 1; }
  token="$(python3 -c 'import sys,urllib.parse;print(urllib.parse.unquote(sys.argv[1]))' "$token")"
  curl -sf -X POST "$BASE/api/auth/register" -H 'content-type: application/json' -H "origin: $BASE" \
    -d "{\"email\":\"$2\",\"password\":\"$3\",\"invite\":\"$token\"}" >/dev/null
}
make_user qa06-a "$A_EMAIL" "$A_PASS"
make_user qa06-b "$B_EMAIL" "$B_PASS"
TA="$(sup -c "select tenant_id from app_user where email='$A_EMAIL'")"

# Tenant A opens the fixture sheet once, so a real manifest exists in its workspace to copy.
JAR="$(mktemp)"
curl -sf -c "$JAR" -X POST "$BASE/api/auth/login" -H 'content-type: application/json' -H "origin: $BASE" \
  -d "{\"email\":\"$A_EMAIL\",\"password\":\"$A_PASS\"}" >/dev/null
curl -s -b "$JAR" "$BASE/api/model/meridian" -o /dev/null
SRC="$(sup -c "select key from tear_sheet where tenant_id='$TA' order by saved_at desc limit 1")"
[ -n "$SRC" ] || { echo "tenant A has no sheet to copy" >&2; exit 1; }
sup -c "insert into tear_sheet (tenant_id, key, contract_version, company_name, synthetic, manifest, saved_at)
  select tenant_id, 'qa06-secret', contract_version, '$MARK Holdings', synthetic,
         jsonb_set(manifest, '{entity,companyName}', '\"$MARK Holdings\"'), now()
  from tear_sheet where tenant_id='$TA' and key='$SRC'
  on conflict (tenant_id, key) do update set manifest = excluded.manifest, company_name = excluded.company_name"
sup -c "insert into run (tenant_id, id, status, input, company_number, sheet_key, record, started_at)
  values ('$TA', 'qa06-run-a', 'done', '$MARK input', '00000000', 'qa06-secret',
          '{\"id\":\"qa06-run-a\",\"status\":\"done\",\"input\":\"$MARK input\",\"sheetKey\":\"qa06-secret\",\"stages\":[]}'::jsonb, now())
  on conflict (tenant_id, id) do update set input = excluded.input, record = excluded.record"
rm -f "$JAR"
echo "BASE=$BASE A_EMAIL=$A_EMAIL A_PASS=$A_PASS B_EMAIL=$B_EMAIL B_PASS=$B_PASS SECRET_KEY=qa06-secret SECRET_RUN=qa06-run-a SECRET_MARK=$MARK TENANT_A=$TA SOURCE_KEY=$SRC"
