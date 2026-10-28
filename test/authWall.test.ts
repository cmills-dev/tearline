// test/authWall.test.ts (WP-QA05 item 5, the auth wall)
// The runtime role app_user must not read the auth tables. Login reads a user by email before any
// tenant is known, so a tenant policy cannot guard those tables. 0015_auth_wall.sql takes every
// privilege on the tables app_user and session away from the role, and gives it six SECURITY
// DEFINER functions that each answer for one exact key.
//
// No database here. Three layers are checked:
//   1. The migration, as text: definer, pinned search_path, the revokes, the grants.
//   2. The Postgres store over pg-mem (test/authWallDouble.ts): login, sessions and invites still
//      work, and the store never names an auth table directly.
//   3. The scripts: nothing the app or its tooling runs as app_user reads the auth tables, and
//      db-wall carries the checks that prove the wall on a real Postgres.
// What only a real Postgres proves (the grants biting, the function bodies) is scripts/db-wall.ts.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { pgMemAuthSql } from "./authWallDouble";
import { suite, test, assert, assertEqual } from "./harness";
import { PostgresAuthStore, setAuthSqlForTests } from "../lib/auth/store";
import { hashPassword, verifyPassword } from "../lib/auth/crypto";
import { readMigrations } from "../lib/db/migrate";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const WALL_SQL = read("db/migrations/0015_auth_wall.sql");
// Code only, comments stripped, so a comment that names a table does not count as a read.
const code = (src: string) => src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const DIRECT_READ = /\b(from|into|update|join)\s+(public\.)?(app_user|session)\b/i;

const FUNCTIONS = [
  "auth_find_user(text)",
  "auth_email_taken(text)",
  "auth_create_user(uuid, text, text, text)",
  "auth_session_create(text, uuid, text, timestamptz)",
  "auth_session_load(text)",
  "auth_session_revoke(text)",
];

export async function registerAuthWallTests(): Promise<void> {
  // ---- 1. The migration ----------------------------------------------------------------------
  suite("WP-QA05 auth wall: 0015_auth_wall.sql");

  test("the role loses every privilege on both auth tables", () => {
    for (const t of ["app_user", "session"]) {
      assert(WALL_SQL.includes(`revoke all on table public.${t} from app_user;`), `revoke ${t} from the role`);
      assert(WALL_SQL.includes(`revoke all on table public.${t} from public;`), `revoke ${t} from public`);
      assert(new RegExp(`alter table public\\.${t}\\s+enable row level security;`).test(WALL_SQL), `rls on ${t}, the second layer`);
    }
    assert(!/force\s+row level security/.test(WALL_SQL), "not forced, so the owner running the functions still reads");
    assert(!/grant\s+(select|insert|update|delete|all)[^;]*on\s+(table\s+)?(public\.)?(app_user|session)\b/i.test(WALL_SQL), "no grant back on either table");
  });

  test("six functions, each SECURITY DEFINER with its search_path pinned", () => {
    for (const f of FUNCTIONS) {
      const name = f.split("(")[0];
      const m = WALL_SQL.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`));
      assert(m, `${name} is defined`);
      assert(/security definer/.test(m![0]), `${name} is security definer`);
      assert(/set search_path = pg_catalog, public, pg_temp/.test(m![0]), `${name} pins search_path`);
      assert(WALL_SQL.includes(`revoke all on function public.${f} from public;`), `${name} not executable by public`);
      assert(WALL_SQL.includes(`grant execute on function public.${f} to app_user;`), `${name} executable by the role`);
    }
  });

  test("login gets one row by exact email, and nothing lists users or sessions", () => {
    const find = WALL_SQL.match(/create or replace function public\.auth_find_user[\s\S]*?\n\$\$;/)![0];
    assert(/u\.email = p_email/.test(find) && /limit 1/.test(find), "exact match, one row");
    assert(/p_email <> ''/.test(find) && /p_email is not null/.test(find), "an empty or null email matches nothing");
    assert(!/like|ilike|~/.test(find.replace(/--.*$/gm, "")), "no pattern match");
    const load = WALL_SQL.match(/create or replace function public\.auth_session_load[\s\S]*?\n\$\$;/)![0];
    assert(/s\.token_hash = p_token_hash/.test(load) && /limit 1/.test(load), "a session by exact token hash, one row");
    const defined = [...WALL_SQL.matchAll(/create or replace function public\.(\w+)/g)].map((m) => m[1]);
    assertEqual(defined.sort().join(","), FUNCTIONS.map((f) => f.split("(")[0]).sort().join(","), "exactly the six, no list function");
  });

  test("the runner puts roles.sql first, so its blanket grant cannot undo the revoke", () => {
    const names = readMigrations(join(ROOT, "db")).map((f) => f.name);
    assertEqual(names[0], "roles.sql", "roles.sql first");
    assert(names.indexOf("0015_auth_wall.sql") > names.indexOf("0014_invites.sql"), "0015 after 0014");
    assertEqual(names.filter((n) => n.startsWith("0015_")).length, 1, "no other 0015");
  });

  // ---- 2. The store over pg-mem -----------------------------------------------------------------
  const double = pgMemAuthSql();
  setAuthSqlForTests(double.sql);
  const store = new PostgresAuthStore();
  const r: Record<string, unknown> = {};
  try {
    const user = await store.createUser("Alice@Desk.com", hashPassword("alice pw"), "desk-a");
    await store.createUser("bob@other.com", hashPassword("bob pw"), "desk-b");
    r.user = user;
    r.found = await store.findUserByEmail("ALICE@desk.com");
    r.unknown = await store.findUserByEmail("nobody@desk.com");
    r.empty = await store.findUserByEmail("");
    const token = await store.createSession(user.id, user.tenantId, new Date(Date.now() + 3600_000));
    r.loaded = await store.loadSession(token);
    await store.revokeSession(token);
    r.revoked = await store.loadSession(token);
    const stale = await store.createSession(user.id, user.tenantId, new Date(Date.now() - 1000));
    r.expired = await store.loadSession(stale);
    r.staleRows = await double.raw("select count(*)::int as n from session");
    try {
      await store.createSession(user.id, "desk-b", new Date(Date.now() + 3600_000));
      r.crossRows = await double.raw("select count(*)::int as n from session where tenant_id = 'desk-b'");
    } catch (e) {
      r.crossRows = [{ n: 0 }];
      r.crossErr = String(e);
    }
    try {
      await double.sql`select email from app_user`;
      r.directErr = "";
    } catch (e) {
      r.directErr = e instanceof Error ? e.message : String(e);
    }
  } finally {
    setAuthSqlForTests(null);
  }

  suite("WP-QA05 auth wall: the Postgres store calls the functions");

  test("login finds exactly the one user by email, case-insensitively, and the password verifies", () => {
    const f = r.found as { id: string; email: string; passwordHash: string; tenantId: string } | null;
    assert(f, "found");
    assertEqual(f!.email, "alice@desk.com", "the lower-cased email");
    assertEqual(f!.tenantId, "desk-a", "its own tenant");
    assertEqual(f!.id, (r.user as { id: string }).id, "the same id");
    assert(verifyPassword("alice pw", f!.passwordHash), "the stored hash verifies the password");
    assertEqual(r.unknown, null, "an unknown email is null");
    assertEqual(r.empty, null, "an empty email is null");
  });

  test("sessions are created, loaded, revoked and expired through the functions", () => {
    assertEqual((r.loaded as { tenantId: string } | null)?.tenantId, "desk-a", "loaded in the user's tenant");
    assertEqual(r.revoked, null, "gone after revoke");
    assertEqual(r.expired, null, "an expired session reads as absent");
    assertEqual((r.staleRows as { n: number }[])[0].n, 0, "and the expired row is cleaned up");
    assertEqual((r.crossRows as { n: number }[])[0].n, 0, "no session is made for a user in another tenant");
  });

  test("every statement goes through a function, never an auth table", () => {
    const sent = double.sent.filter((s) => !s.startsWith("select email from app_user"));
    const offenders = sent.filter((s) => DIRECT_READ.test(s));
    assertEqual(offenders.join(" | "), "", "no direct statement on app_user or session");
    for (const fn of ["auth_create_user", "auth_find_user", "auth_session_create", "auth_session_load", "auth_session_revoke"]) {
      assert(sent.some((s) => s.includes(fn)), `${fn} was called`);
    }
    assert(/auth wall/.test(String(r.directErr)), `the double refuses a direct read: ${r.directErr}`);
  });

  // ---- 3. The code that runs as app_user -------------------------------------------------------
  suite("WP-QA05 auth wall: nothing running as app_user reads the auth tables");

  test("the auth store and the preview validator name no auth table in SQL", () => {
    for (const p of ["lib/auth/store.ts", "scripts/validate-names-http.ts"]) {
      const hit = code(read(p)).match(DIRECT_READ);
      assert(!hit, `${p} reads an auth table directly: ${hit?.[0]}`);
    }
  });

  test("db-wall checks the grant, the refused select, the functions and a login round trip", () => {
    const wall = code(read("scripts/db-wall.ts"));
    assert(/has_table_privilege\(current_user, \$1, 'SELECT'\)/.test(wall), "privilege check");
    assert(/select count\(\*\) from public\.\$\{t\}/.test(wall) && /permission denied/.test(wall), "a direct select must be refused");
    assert(/prosecdef/.test(wall) && /search_path=/.test(wall) && /has_function_privilege/.test(wall), "definer, search_path, execute");
    assert(/auth_create_user\(\$1, \$2, \$3, \$4\)/.test(wall) && /from auth_find_user\(\$1\)/.test(wall), "creates and finds a user");
    assert(/verifyPassword\(password/.test(wall), "and verifies the password");
    assert(/throw new Rollback\(\)/.test(wall), "inside a rolled-back transaction");
    assert(!/\bapp_user: "auth table/.test(wall), "the auth tables are no longer exempt");
  });
}
