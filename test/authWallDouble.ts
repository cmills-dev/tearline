// test/authWallDouble.ts (WP-QA05 auth wall)
// pg-mem behind the tagged-template shape PostgresAuthStore calls, over the real CREATE TABLE
// statements lifted from 0001, 0002 and 0014.
//
// What this proves, and what it does not. pg-mem cannot run SECURITY DEFINER functions or
// set-returning SQL functions, and it has no roles or grants. So each call the store makes to a
// function in db/migrations/0015_auth_wall.sql is rewritten here, before pg-mem sees it, into the
// plain SQL that function's body runs. The tests therefore prove the store's side: which function
// it calls, with which arguments, and how it reads the answer. They do not prove the function
// bodies, the revoke or the grants. scripts/db-wall.ts proves those on a real Postgres, as the
// runtime role. A store query that names neither a known function nor a non-auth table is
// refused, so a new direct read of the auth tables fails the tests instead of passing silently.

import { readFileSync } from "fs";
import { randomUUID } from "crypto";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { newDb, DataType } from "pg-mem";
import type { Sql } from "../lib/auth/store";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "db", "migrations");

function createTableSql(file: string, table: string): string {
  const sql = readFileSync(join(MIGRATIONS, file), "utf8");
  const m = sql.match(new RegExp(`create table if not exists ${table} \\([\\s\\S]*?\\n\\);`));
  if (!m) throw new Error(`no create table ${table} in ${file}`);
  return m[0];
}

// Each function in 0015, as the SQL its body runs. The session insert keeps the body's join on
// the user's own tenant, so a mismatched tenant inserts nothing (the real body then raises).
export const AUTH_WALL_REWRITES: { fn: string; from: RegExp; to: string }[] = [
  {
    fn: "auth_find_user",
    from: /from auth_find_user\(\$(\d+)\)/,
    to: "from app_user where email = $$1 and email <> '' limit 1",
  },
  {
    fn: "auth_email_taken",
    from: /select auth_email_taken\(\$(\d+)\) as taken/,
    to: "select count(*) > 0 as taken from app_user where email = $$1 and email <> ''",
  },
  {
    fn: "auth_create_user",
    from: /select auth_create_user\(\$(\d+), \$(\d+), \$(\d+), \$(\d+)\)/,
    to: "insert into app_user (id, email, password_hash, tenant_id) values ($$1, $$2, $$3, $$4)",
  },
  {
    fn: "auth_session_create",
    from: /select auth_session_create\(\$(\d+), \$(\d+), \$(\d+), \$(\d+)\)/,
    to: "insert into session (token_hash, user_id, tenant_id, expires_at) select $$1, id, tenant_id, $$4::timestamptz from app_user where id = $$2 and tenant_id = $$3",
  },
  {
    fn: "auth_session_load",
    from: /from auth_session_load\(\$(\d+)\)/,
    to: "from session where token_hash = $$1 limit 1",
  },
  {
    fn: "auth_session_revoke",
    from: /select auth_session_revoke\(\$(\d+)\)/,
    to: "delete from session where token_hash = $$1",
  },
];

// A query that touches the auth tables directly is what the wall forbids.
const DIRECT = /\b(from|into|update|join)\s+(app_user|session)\b/i;

export interface AuthDouble {
  sql: Sql;
  // Every statement the store sent, before rewriting, so a test can see what was called.
  sent: string[];
  // Runs raw SQL against pg-mem, for a test that needs to look at a row the store wrote.
  raw(text: string, values?: unknown[]): Promise<Record<string, unknown>[]>;
}

export function pgMemAuthSql(): AuthDouble {
  const db = newDb();
  db.public.registerFunction({ name: "gen_random_uuid", returns: DataType.uuid, implementation: () => randomUUID(), impure: true });
  db.public.registerFunction({
    name: "set_config",
    args: [DataType.text, DataType.text, DataType.bool],
    returns: DataType.text,
    implementation: (_k: string, v: string) => v,
    impure: true,
  });
  db.public.none(
    [
      createTableSql("0001_init.sql", "tenant"),
      createTableSql("0002_auth.sql", "app_user"),
      createTableSql("0002_auth.sql", "session"),
      createTableSql("0014_invites.sql", "invite"),
    ].join("\n"),
  );
  const { Client } = db.adapters.createPg();
  const client = new Client();
  const sent: string[] = [];
  const raw = async (text: string, values: unknown[] = []) => (await client.query(text, values)).rows as Record<string, unknown>[];
  const tag = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((acc, s, i) => `${acc}$${i}${s}`).replace(/\s+/g, " ").trim();
    sent.push(text);
    if (DIRECT.test(text)) throw new Error(`auth wall: the store read an auth table directly: ${text}`);
    let rewritten = text;
    for (const r of AUTH_WALL_REWRITES) {
      const m = rewritten.match(r.from);
      if (!m) continue;
      // $$n in the template is the n-th captured placeholder of the call.
      const body = r.to.replace(/\$\$(\d)/g, (_x, n: string) => `$${m[Number(n)]}`);
      rewritten = rewritten.replace(r.from, () => body);
    }
    return raw(rewritten, values);
  }) as unknown as Sql;
  tag.json = (v: unknown) => v;
  // begin() runs the callback on the same connection; pg-mem has no rollback here, which the
  // happy-path checks do not need.
  tag.begin = async <T>(fn: (tx: Sql) => Promise<T>) => fn(tag);
  return { sql: tag, sent, raw };
}
