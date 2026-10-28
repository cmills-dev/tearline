// scripts/db-migrate.ts (WP-DS02, DSD-05)
// Applies db/roles.sql, then db/migrations/0001.. in order, as the OWNER role. Each file
// runs in its own transaction and is recorded in `schema_migrations` with its sha256, so a
// second run does nothing and a file edited after it was applied is reported as drift.
//
//   OWNER_DATABASE_URL=... npx tsx scripts/db-migrate.ts            apply what is pending
//   OWNER_DATABASE_URL=... npx tsx scripts/db-migrate.ts --status   print the plan, change nothing
//   OWNER_DATABASE_URL=... APP_USER_PASSWORD=... npx tsx scripts/db-migrate.ts --set-app-password
//
// Only OWNER_DATABASE_URL is read. The app's URL (APP_DATABASE_URL, the app_user role) cannot run
// DDL, and DATABASE_URL may be either, so neither is ever used here. Exit 0 ok, 1 failed, 2 drift.

import { resolve } from "node:path";
import { LEDGER_DDL, alterPasswordSql, plan, readMigrations, type Applied } from "../lib/db/migrate";

type Sql = {
  unsafe(q: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  begin<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  end(): Promise<void>;
};

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const statusOnly = argv.includes("--status");
  const setPassword = argv.includes("--set-app-password");
  const url = process.env.OWNER_DATABASE_URL;
  if (!url) {
    console.error("db-migrate: OWNER_DATABASE_URL is not set. It is the owner role's URL and lives only in .env.local.");
    return 1;
  }
  const mod = await import("postgres");
  const postgres = (mod.default ?? mod) as unknown as (u: string, o?: unknown) => Sql;
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const who = await sql.unsafe("select current_user::text as u, current_database()::text as d");
    console.log(`db-migrate: connected as ${who[0].u} to ${who[0].d}`);
    await sql.unsafe(LEDGER_DDL);
    const applied = (await sql.unsafe("select name, sha256 from schema_migrations order by name")) as unknown as Applied[];
    const files = readMigrations(resolve(__dirname, "..", "db"));
    const p = plan(files, applied);
    for (const d of p.drifted) console.warn(`db-migrate: DRIFT ${d} changed on disk after it was applied`);
    for (const u of p.unknown) console.warn(`db-migrate: ${u} is recorded in the database but not on disk`);
    console.log(`db-migrate: ${applied.length} applied, ${p.pending.length} pending${p.pending.length ? ": " + p.pending.map((f) => f.name).join(", ") : ""}`);
    if (statusOnly) return p.drifted.length ? 2 : 0;

    for (const f of p.pending) {
      await sql.begin(async (tx) => {
        await tx.unsafe(f.sql);
        await tx.unsafe("insert into schema_migrations (name, sha256) values ($1, $2)", [f.name, f.sha256]);
      });
      console.log(`db-migrate: applied ${f.name}`);
    }
    if (setPassword) {
      const pw = process.env.APP_USER_PASSWORD;
      if (!pw) {
        console.error("db-migrate: --set-app-password needs APP_USER_PASSWORD in the environment");
        return 1;
      }
      await sql.unsafe(alterPasswordSql("app_user", pw));
      console.log("db-migrate: app_user password set (value not printed)");
    }
    if (!p.pending.length && !setPassword) console.log("db-migrate: nothing to do");
    return p.drifted.length ? 2 : 0;
  } catch (e) {
    console.error(`db-migrate: FAILED: ${(e as Error).message}`);
    return 1;
  } finally {
    await sql.end();
  }
}

main().then((code) => process.exit(code));
