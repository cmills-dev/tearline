// scripts/db-wall.ts: prove the tenant wall from the database's side, as the app's own role.
//
//   APP_DATABASE_URL=postgres://app_user:...@host/db npx tsx scripts/db-wall.ts     (npm run db:wall)
//
// db-parity.ts proves the stores isolate through the app's code. This proves the database would
// hold the wall even if the code forgot its WHERE clause:
//   1. The connection is app_user: not a superuser, no BYPASSRLS, and it owns no table.
//   2. Every table with a tenant_id column has row-level security ENABLED and FORCED, and at
//      least one policy. `tenant` (the list of tenants) is exempt and printed as EXEMPT, not PASS.
//      The auth tables `app_user` and `session` are read before any tenant is known, so a tenant
//      policy cannot apply to them. They are walled instead (check 4).
//   3. The check from db/README.md ("Verify tenant isolation"): tenant A writes a tear sheet,
//      tenant B counts 0 of it, tenant B cannot write a row stamped as tenant A, and a session
//      with no tenant set sees nothing. All inside one transaction that is rolled back, so the
//      database is left as it was found.
//   4. The auth wall (db/migrations/0015_auth_wall.sql, WP-QA05). The role holds no privilege on
//      the tables app_user and session, and a direct SELECT on either is refused. The six auth
//      functions are SECURITY DEFINER with a pinned search_path, and the role may execute them.
//      Then login still works: inside a rolled-back transaction a user is created through
//      auth_create_user, auth_find_user returns exactly that one row, its hash verifies the
//      password, and a session is created, loaded and revoked by token hash.
// Exit 0 when every check holds, 1 otherwise.

type Row = Record<string, unknown>;
type Sql = {
  unsafe(q: string, params?: unknown[]): Promise<Row[]>;
  begin<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  end(): Promise<void>;
};

import { randomUUID } from "crypto";
import { hashPassword, verifyPassword } from "../lib/auth/crypto";

const EXEMPT: Record<string, string> = {
  tenant: "the list of tenants",
};
// Read before a tenant is known, so no tenant policy. Walled by 0015 instead (check 4).
const AUTH_TABLES = ["app_user", "session"];
const AUTH_FUNCTIONS = [
  "auth_find_user(text)",
  "auth_email_taken(text)",
  "auth_create_user(uuid, text, text, text)",
  "auth_session_create(text, uuid, text, timestamptz)",
  "auth_session_load(text)",
  "auth_session_revoke(text)",
];
let failures = 0;
const check = (ok: boolean, what: string, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
};

class Rollback extends Error {}

async function main(): Promise<number> {
  const url = process.env.APP_DATABASE_URL;
  if (!url) {
    console.error("db-wall: APP_DATABASE_URL is not set. It is the app_user URL the app connects with.");
    return 1;
  }
  const mod = await import("postgres");
  const postgres = (mod.default ?? mod) as unknown as (u: string, o?: unknown) => Sql;
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    console.log("db-wall: the role");
    const [me] = await sql.unsafe(
      `select current_user::text as u, r.rolsuper as sup, r.rolbypassrls as byp
         from pg_roles r where r.rolname = current_user`,
    );
    check(me.u === "app_user", "connected as app_user", String(me.u));
    check(me.sup === false, "not a superuser");
    check(me.byp === false, "no BYPASSRLS");
    const owned = await sql.unsafe(
      `select c.relname::text as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and pg_get_userbyid(c.relowner) = current_user`,
    );
    check(owned.length === 0, "owns no table", owned.map((r) => r.t).join(", "));

    console.log("db-wall: every tenant table is behind forced RLS");
    const tables = await sql.unsafe(
      `select c.relname::text as t, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
              (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and exists (select 1 from pg_attribute a where a.attrelid = c.oid
                       and a.attname = 'tenant_id' and not a.attisdropped)
        order by 1`,
    );
    for (const r of tables) {
      if (AUTH_TABLES.includes(String(r.t))) {
        console.log(`  WALLED ${r.t}  (auth table, no tenant policy possible; see the auth wall below)`);
        continue;
      }
      const why = EXEMPT[String(r.t)];
      if (why) {
        console.log(`  EXEMPT ${r.t}  (${why}; rls ${r.rls}, forced ${r.forced})`);
        continue;
      }
      check(r.rls === true && r.forced === true && Number(r.policies) > 0, String(r.t),
        `rls ${r.rls}, forced ${r.forced}, policies ${r.policies}`);
    }

    console.log("db-wall: the README isolation check (rolled back)");
    const tag = `wall-${Date.now().toString(36)}`;
    const [a, b] = [`${tag}-a`, `${tag}-b`];
    await sql
      .begin(async (tx) => {
        await tx.unsafe("insert into tenant (id, name) values ($1, 'Wall A'), ($2, 'Wall B') on conflict (id) do nothing", [a, b]);
        await tx.unsafe("select set_config('app.tenant_id', $1, true)", [a]);
        await tx.unsafe(
          "insert into tear_sheet (tenant_id, key, contract_version, company_name, manifest) values ($1, 'ISO-CHECK', 'v1', 'Isolation Test Co', '{}'::jsonb)",
          [a],
        );
        const seenA = await tx.unsafe("select count(*)::int as n from tear_sheet where key = 'ISO-CHECK'");
        check(seenA[0].n === 1, "tenant A sees its own row", `count ${seenA[0].n}`);
        await tx.unsafe("select set_config('app.tenant_id', $1, true)", [b]);
        const seenB = await tx.unsafe("select count(*)::int as n from tear_sheet where key = 'ISO-CHECK'");
        check(seenB[0].n === 0, "tenant B sees none of A's rows", `count ${seenB[0].n}`);
        await tx.unsafe("savepoint s1");
        let blocked = "";
        try {
          await tx.unsafe(
            "insert into tear_sheet (tenant_id, key, contract_version, company_name, manifest) values ($1, 'ISO-CHECK-2', 'v1', 'Should Fail', '{}'::jsonb)",
            [a],
          );
        } catch (err) {
          blocked = err instanceof Error ? err.message : String(err);
        }
        await tx.unsafe("rollback to savepoint s1");
        check(/row-level security/i.test(blocked), "tenant B cannot write a row stamped tenant A", blocked || "insert succeeded");
        await tx.unsafe("select set_config('app.tenant_id', '', true)");
        const seenNone = await tx.unsafe("select count(*)::int as n from tear_sheet");
        check(seenNone[0].n === 0, "no tenant set sees nothing", `count ${seenNone[0].n}`);
        throw new Rollback();
      })
      .catch((err) => {
        if (!(err instanceof Rollback)) throw err;
      });

    console.log("db-wall: the auth wall (0015): no direct read of the auth tables");
    for (const t of AUTH_TABLES) {
      const [p] = await sql.unsafe(
        `select has_table_privilege(current_user, $1, 'SELECT') as s, has_table_privilege(current_user, $1, 'INSERT') as i,
                has_table_privilege(current_user, $1, 'UPDATE') as u, has_table_privilege(current_user, $1, 'DELETE') as d`,
        [`public.${t}`],
      );
      check(!p.s && !p.i && !p.u && !p.d, `app_user holds no privilege on table ${t}`, `select ${p.s}, insert ${p.i}, update ${p.u}, delete ${p.d}`);
      let refused = "";
      try {
        await sql.unsafe(`select count(*) from public.${t}`);
      } catch (err) {
        refused = err instanceof Error ? err.message : String(err);
      }
      check(/permission denied/i.test(refused), `select from ${t} is refused`, refused || "the select succeeded");
    }
    for (const f of AUTH_FUNCTIONS) {
      const [r] = await sql.unsafe(
        `select p.prosecdef as def, coalesce(array_to_string(p.proconfig, ','), '') as cfg,
                has_function_privilege(current_user, p.oid, 'EXECUTE') as ex
           from pg_proc p where p.oid = to_regprocedure($1)`,
        [`public.${f}`],
      );
      check(!!r && r.def === true && /search_path=/.test(String(r.cfg)) && r.ex === true, `${f.split("(")[0]} is SECURITY DEFINER, search_path pinned, executable`,
        r ? `definer ${r.def}, config ${r.cfg || "none"}, execute ${r.ex}` : "missing");
    }

    console.log("db-wall: login still works through the functions (rolled back)");
    const email = `${tag}@wall.local`;
    const password = `pw-${tag}`;
    const userId = randomUUID();
    const token = `tok-${tag}`;
    await sql
      .begin(async (tx) => {
        await tx.unsafe("insert into tenant (id, name) values ($1, 'Wall Auth') on conflict (id) do nothing", [a]);
        await tx.unsafe("select auth_create_user($1, $2, $3, $4)", [userId, email, hashPassword(password), a]);
        const found = await tx.unsafe("select id, email, password_hash, tenant_id from auth_find_user($1)", [email]);
        check(found.length === 1 && String(found[0].id) === userId && found[0].tenant_id === a, "auth_find_user returns exactly the one row", `rows ${found.length}`);
        check(found.length === 1 && verifyPassword(password, String(found[0].password_hash)), "its hash verifies the password");
        const none = await tx.unsafe("select id from auth_find_user($1)", [`nobody-${email}`]);
        const empty = await tx.unsafe("select id from auth_find_user($1)", [""]);
        check(none.length === 0 && empty.length === 0, "an unknown or empty email returns no row", `unknown ${none.length}, empty ${empty.length}`);
        const [taken] = await tx.unsafe("select auth_email_taken($1) as t", [email]);
        check(taken.t === true, "auth_email_taken says true for it");
        await tx.unsafe("select auth_session_create($1, $2, $3, now() + interval '1 hour')", [token, userId, a]);
        const loaded = await tx.unsafe("select user_id, tenant_id from auth_session_load($1)", [token]);
        check(loaded.length === 1 && String(loaded[0].user_id) === userId, "a session is created and loaded by its token hash", `rows ${loaded.length}`);
        await tx.unsafe("select auth_session_revoke($1)", [token]);
        const gone = await tx.unsafe("select user_id from auth_session_load($1)", [token]);
        check(gone.length === 0, "and revoked", `rows ${gone.length}`);
        throw new Rollback();
      })
      .catch((err) => {
        if (!(err instanceof Rollback)) throw err;
      });

    console.log(failures === 0 ? "RESULT: PASS - the wall holds for app_user" : `RESULT: FAIL - ${failures} check(s) failed`);
    return failures === 0 ? 0 : 1;
  } finally {
    await sql.end().catch(() => {});
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("db-wall:", err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
