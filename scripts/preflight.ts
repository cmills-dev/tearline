// scripts/preflight.ts (WP-DS04, WP-DS08)
// Does the hosted preview (or production) have everything it needs? Run from product/:
//
//   npx tsx scripts/preflight.ts                                   # .env.local, target preview
//   vercel env pull --environment=preview .env.preview.pulled
//   npx tsx scripts/preflight.ts --target preview --env-file .env.preview.pulled
//   npx tsx scripts/preflight.ts --target preview --env-file .env.preview.pulled --url https://<app preview host>
//   npx tsx scripts/preflight.ts --env-file .env.local --db      # connects with APP_DATABASE_URL
//
// Prints one row per check: PASS, WARN, MISSING or FAIL, with what to do. Never prints a value.
// A database URL is shown as its username and host only.
// Exit: 0 when nothing is MISSING or FAIL, 1 otherwise, 2 bad arguments.
// The checks live in lib/release/preflight.ts, where the unit tests drive them.

import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  checkDbFacts,
  checkEnv,
  checkHealth,
  checkRepo,
  exitCode,
  latestMigrationFrom,
  looksPulled,
  parseArgs,
  parseEnvFile,
  renderTable,
  type Check,
  type DbFacts,
  type EnvMap,
} from "../lib/release/preflight";

const HELP = `preflight.ts: is the hosted preview or production ready? (WP-DS04, WP-DS08)

  --target preview|production   default preview
  --env-file <path>             default .env.local. For Vercel: vercel env pull --environment=preview .env.preview.pulled
  --url <app url>               also GET <url>/api/health (sends SMOKE_BYPASS_TOKEN from the env file if set)
  --db                          also connect with APP_DATABASE_URL and check the role (needs the postgres package)
  --json                        print the rows as JSON

  Prints names, usernames and hosts. Never a value.
  Exit: 0 nothing missing, 1 something missing or failing, 2 bad arguments`;

const PRODUCT = resolve(__dirname, "..");
const ROOT = resolve(PRODUCT, "..");

function readOrNull(p: string): string | null {
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

async function healthChecks(url: string, env: EnvMap, target: "preview" | "production"): Promise<Check[]> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (env.SMOKE_BYPASS_TOKEN) headers["x-vercel-protection-bypass"] = env.SMOKE_BYPASS_TOKEN;
  try {
    const res = await fetch(`${url}/api/health`, { headers, signal: AbortSignal.timeout(15_000) });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return checkHealth(res.status, body, target);
  } catch (e) {
    return [{ id: "health: reachable", status: "FAIL", detail: `request failed (${(e as Error).name})`, fix: "Check the URL and that the deploy finished." }];
  }
}

// Connects as the app would and reads its own role. The driver is imported dynamically so the
// script runs before WP-DS01 installs it.
async function dbChecks(env: EnvMap): Promise<Check[]> {
  const url = env.APP_DATABASE_URL;
  if (!url) return [{ id: "db: connect", status: "MISSING", detail: "APP_DATABASE_URL not set in the env file", fix: "Set it, then re-run with --db." }];
  let postgres: (u: string, o: Record<string, unknown>) => any;
  try {
    const mod = "postgres";
    postgres = (await import(mod)).default;
  } catch {
    return [{ id: "db: connect", status: "WARN", detail: "the postgres package is not installed, role not checked", fix: "Merge WP-DS01, then re-run with --db." }];
  }
  const sql = postgres(url, { max: 1, connect_timeout: 10, idle_timeout: 1, onnotice: () => {} });
  try {
    const [role] = await sql`select current_user as u, r.rolsuper, r.rolbypassrls from pg_roles r where r.rolname = current_user`;
    const [owned] = await sql`
      select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r','p') and pg_get_userbyid(c.relowner) = current_user
        and n.nspname not in ('pg_catalog','information_schema')`;
    const facts: DbFacts = {
      currentUser: String(role.u),
      rolsuper: Boolean(role.rolsuper),
      rolbypassrls: Boolean(role.rolbypassrls),
      ownedTables: Number(owned.n),
      latestMigration: null,
    };
    try {
      const rows = await sql`select * from schema_migrations`;
      facts.latestMigration = latestMigrationFrom(rows as Array<Record<string, unknown>>);
    } catch (e) {
      facts.migrationsError = (e as { code?: string }).code === "42P01" ? "table does not exist" : `error ${(e as { code?: string }).code ?? "unknown"}`;
    }
    return [{ id: "db: connect", status: "PASS", detail: "connected with APP_DATABASE_URL" }, ...checkDbFacts(facts)];
  } catch (e) {
    return [{ id: "db: connect", status: "FAIL", detail: `could not connect (${(e as { code?: string }).code ?? (e as Error).name})`, fix: "Check the host, the app_user password and sslmode=require." }];
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  if (args.errors.length) {
    for (const e of args.errors) console.error(`preflight: ${e}`);
    console.error("Run with --help for usage.");
    return 2;
  }

  const envPath = resolve(process.cwd(), args.envFile);
  const checks: Check[] = [];
  let env: EnvMap = {};
  let pulled = false;
  const text = readOrNull(envPath);
  if (text === null) {
    checks.push({ id: "env file", status: "MISSING", detail: `${args.envFile} not found`, fix: "vercel env pull --environment=preview .env.preview.pulled, or create .env.local." });
  } else {
    env = parseEnvFile(text);
    pulled = looksPulled(text, basename(envPath));
    checks.push({ id: "env file", status: "PASS", detail: `${basename(envPath)}, ${Object.keys(env).length} names, ${pulled ? "a Vercel pull" : "local"}` });
  }

  checks.push(...checkEnv(env, { target: args.target, pulled }));
  checks.push(
    ...checkRepo({
      productPackageJson: readOrNull(join(PRODUCT, "package.json")),
      productVercelJson: readOrNull(join(PRODUCT, "vercel.json")),
      runRoute: readOrNull(join(PRODUCT, "app", "api", "run", "route.ts")),
      narrativeVercelJson: readOrNull(join(ROOT, "sites", "narrative", "vercel.json")),
      narrativeNextConfig: readOrNull(join(ROOT, "sites", "narrative", "next.config.ts")),
    }),
  );
  if (args.url) checks.push(...(await healthChecks(args.url, env, args.target)));
  if (args.db) checks.push(...(await dbChecks(env)));

  if (args.json) console.log(JSON.stringify({ target: args.target, checks, exit: exitCode(checks) }, null, 2));
  else {
    console.log(`Preflight, target ${args.target}${args.url ? `, app ${args.url}` : ""}\n`);
    console.log(renderTable(checks));
  }
  return exitCode(checks);
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`preflight: ${(e as Error).message}`);
    process.exit(1);
  },
);
