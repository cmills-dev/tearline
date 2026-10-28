// lib/release/preflight.ts (WP-DS04, WP-DS08)
// The pure checks behind scripts/preflight.ts. Given an env map, some repo files, a health body and
// some database facts, each function returns rows of PASS / WARN / MISSING / FAIL with what to do.
//
// Rules this file keeps:
//   - A value is never returned or printed. A database URL is reduced to its username and host.
//   - MISSING means a name is absent or still a placeholder. FAIL means it is present but wrong
//     (the app would connect as the owner, a local-only secret sits in a Vercel file).
//   - The exit code is 0 only when no row is MISSING or FAIL.

import { productionReadiness } from "../config/prodGuard";

export type Status = "PASS" | "WARN" | "MISSING" | "FAIL";
export type Target = "preview" | "production";

export interface Check {
  id: string;
  status: Status;
  detail: string; // safe to print: never a value
  fix?: string; // what to do, for any row that is not PASS
}

export type EnvMap = Record<string, string>;

// ---------------------------------------------------------------------------------------------
// Env files

// Parses a dotenv file the way `vercel env pull` and a hand-written .env.local look: NAME=value,
// optional `export `, optional single or double quotes, # comments. No interpolation.
export function parseEnvFile(text: string): EnvMap {
  const out: EnvMap = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    const q = v[0];
    if ((q === '"' || q === "'") && v.length >= 2 && v.endsWith(q)) {
      v = v.slice(1, -1);
      if (q === '"') v = v.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else {
      // An unquoted value ends at an inline comment.
      v = v.replace(/\s+#.*$/, "").trim();
    }
    out[m[1]] = v;
  }
  return out;
}

// True when the file came from `vercel env pull`. The CLI writes a header comment and the
// VERCEL_* system variables. A filename with "pulled" in it counts too.
export function looksPulled(text: string, fileName: string): boolean {
  if (/created by vercel cli/i.test(text)) return true;
  if (/^\s*VERCEL_ENV\s*=/m.test(text)) return true;
  return /pulled|\.vercel/i.test(fileName);
}

const EXAMPLE_DB_URL = "postgres://user:password@host:5432/dbname";

// True for an empty value or an obvious placeholder copied from an example.
export function isPlaceholder(value: string | undefined): boolean {
  if (value === undefined) return true;
  const v = value.trim();
  if (!v) return true;
  if (v === EXAMPLE_DB_URL) return true;
  if (/change_?me/i.test(v)) return true;
  if (/^<.*>$/.test(v)) return true;
  if (v.includes("...")) return true;
  if (/^(x+|todo|tbd|placeholder|none|null|undefined)$/i.test(v)) return true;
  if (/^your[-_ ]/i.test(v)) return true;
  return false;
}

export interface DbUrlParts {
  user: string;
  host: string;
  hasPassword: boolean;
  passwordPlaceholder: boolean;
}

// Reduces a Postgres URL to what is safe to print. Null when it does not parse as one.
export function describeDbUrl(url: string | undefined): DbUrlParts | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") return null;
  const password = decodeURIComponent(u.password);
  return {
    user: decodeURIComponent(u.username),
    host: u.hostname,
    hasPassword: password.length > 0,
    passwordPlaceholder: /change_?me/i.test(password) || password === "password",
  };
}

// ---------------------------------------------------------------------------------------------
// Env checks

export interface EnvCheckOptions {
  target: Target;
  pulled: boolean; // the file is a `vercel env pull` output, so it stands for what Vercel holds
}

const GEN_SECRET = 'printf %s "$(openssl rand -base64 48)"';

function addHint(target: Target, name: string): string {
  return `vercel env add ${name} ${target}`;
}

// A present-but-empty value in a pulled file may be a Vercel "Sensitive" variable, which the CLI
// cannot read back. It is reported as WARN, since the name is there but nothing can be judged.
function sensitiveBlank(env: EnvMap, name: string, pulled: boolean): boolean {
  return pulled && name in env && env[name].trim() === "";
}

function requireName(env: EnvMap, name: string, o: EnvCheckOptions, fix: string, id = name): Check {
  if (sensitiveBlank(env, name, o.pulled)) {
    return {
      id,
      status: "WARN",
      detail: "name present, value blank in the pulled file",
      fix: "If it is marked Sensitive in Vercel the CLI cannot pull it. Confirm it in the dashboard.",
    };
  }
  if (!(name in env)) return { id, status: "MISSING", detail: "not set", fix };
  if (isPlaceholder(env[name])) return { id, status: "MISSING", detail: "set to a placeholder", fix };
  return { id, status: "PASS", detail: "set" };
}

// The five secrets prodGuard requires. The verdict comes from productionReadiness itself, run as
// production, so this cannot drift from what the deployed app enforces.
const PROD_GUARD_NAMES: Array<{ name: string; fix: (t: Target) => string; detail: string }> = [
  { name: "AUTH_SECRET", fix: (t) => `${GEN_SECRET} | ${addHint(t, "AUTH_SECRET")}`, detail: "24+ characters, not a dev value" },
  { name: "AUTH_REQUIRED", fix: (t) => `printf %s 1 | ${addHint(t, "AUTH_REQUIRED")}`, detail: "must be exactly 1" },
  { name: "SHARED_HASH_PEPPER", fix: (t) => `${GEN_SECRET} | ${addHint(t, "SHARED_HASH_PEPPER")}`, detail: "not the dev pepper" },
  { name: "CRON_SECRET", fix: (t) => `${GEN_SECRET} | ${addHint(t, "CRON_SECRET")}`, detail: "guards the 06:00 monitor cron" },
  { name: "SHARED_ADMIN_SECRET", fix: (t) => `${GEN_SECRET} | ${addHint(t, "SHARED_ADMIN_SECRET")}`, detail: "guards shared-dictionary promotion" },
];

function prodGuardChecks(env: EnvMap, o: EnvCheckOptions): Check[] {
  const probe = { ...env, NODE_ENV: "production", VERCEL_ENV: "production" } as NodeJS.ProcessEnv;
  const missing = new Set(productionReadiness(probe).missing);
  return PROD_GUARD_NAMES.map(({ name, fix, detail }) => {
    if (sensitiveBlank(env, name, o.pulled)) return requireName(env, name, o, fix(o.target));
    if (!(name in env)) return { id: name, status: "MISSING", detail: "not set", fix: fix(o.target) };
    if (missing.has(name) || isPlaceholder(env[name])) {
      return { id: name, status: "MISSING", detail: `set but rejected by prodGuard (${detail})`, fix: fix(o.target) };
    }
    return { id: name, status: "PASS", detail: `set, passes prodGuard` };
  });
}

function dbChecks(env: EnvMap, o: EnvCheckOptions): Check[] {
  const out: Check[] = [];
  const appFix = `Build postgresql://app_user:<APP_USER_PASSWORD>@<pooled host>/<db>?sslmode=require, then ${addHint(o.target, "APP_DATABASE_URL")}`;
  const app = env.APP_DATABASE_URL;
  const appParts = describeDbUrl(app);

  if (sensitiveBlank(env, "APP_DATABASE_URL", o.pulled)) {
    out.push(requireName(env, "APP_DATABASE_URL", o, appFix));
  } else if (!app || isPlaceholder(app)) {
    out.push({ id: "APP_DATABASE_URL", status: "MISSING", detail: app ? "set to a placeholder" : "not set", fix: appFix });
  } else if (!appParts) {
    out.push({ id: "APP_DATABASE_URL", status: "FAIL", detail: "set but not a postgres:// URL", fix: appFix });
  } else if (appParts.user !== "app_user") {
    out.push({
      id: "APP_DATABASE_URL",
      status: "FAIL",
      detail: `user ${appParts.user} at ${appParts.host}, not app_user`,
      fix: "The app must connect as app_user. The owner bypasses row-level security. " + appFix,
    });
  } else if (!appParts.hasPassword || appParts.passwordPlaceholder) {
    out.push({
      id: "APP_DATABASE_URL",
      status: "FAIL",
      detail: `user app_user at ${appParts.host}, password missing or a placeholder`,
      fix: "Run db-migrate with APP_USER_PASSWORD set, then rebuild the URL with that password.",
    });
  } else {
    out.push({ id: "APP_DATABASE_URL", status: "PASS", detail: `user app_user at ${appParts.host}` });
  }

  // DATABASE_URL and POSTGRES_URL: the Neon integration injects them as the owner.
  for (const name of ["DATABASE_URL", "POSTGRES_URL"]) {
    if (!(name in env) || isPlaceholder(env[name])) continue;
    const p = describeDbUrl(env[name]);
    const who = p ? `user ${p.user} at ${p.host}` : "not a postgres:// URL";
    const isApp = p?.user === "app_user";
    if (appParts && app && !isPlaceholder(app)) {
      out.push({
        id: name,
        status: isApp ? "PASS" : "WARN",
        detail: `${who}. APP_DATABASE_URL wins, so the app ignores it`,
        fix: isApp ? undefined : "Harmless to the app. Any other tool that reads it connects as the owner. Leave it or remove it in Vercel.",
      });
    } else {
      out.push({
        id: name,
        status: isApp ? "WARN" : "FAIL",
        detail: `${who}, and it is the only database variable the app would read`,
        fix: isApp
          ? "Works, but set APP_DATABASE_URL so the owner URL the integration injects can never win."
          : "The app would connect as the owner and bypass row-level security. Set APP_DATABASE_URL to the app_user URL.",
      });
    }
  }

  // Local-only secrets. In a Vercel file they are a leak. In .env.local they are expected.
  for (const name of ["OWNER_DATABASE_URL", "APP_USER_PASSWORD"]) {
    const present = name in env && env[name].trim() !== "";
    if (o.pulled) {
      out.push(
        present || name in env
          ? { id: name, status: "FAIL", detail: "present in the Vercel environment", fix: `Local only. vercel env rm ${name} ${o.target}` }
          : { id: name, status: "PASS", detail: "not in the Vercel environment (correct)" },
      );
    } else if (name === "OWNER_DATABASE_URL") {
      const p = describeDbUrl(env[name]);
      out.push(
        present && p
          ? { id: name, status: "PASS", detail: `local only, user ${p.user} at ${p.host}` }
          : { id: name, status: "WARN", detail: "not set locally", fix: "Needed to run scripts/db-migrate.ts. Copy the Neon owner URL for the branch into .env.local." },
      );
    }
    // APP_USER_PASSWORD locally is optional: it is only read by db-migrate when set.
  }
  return out;
}

const MAIL_NAMES = ["RESEND_API_KEY", "MAIL_FROM_INVITES", "MAIL_FROM_DEMO", "MAIL_DEMO_INBOX"];

export function checkEnv(env: EnvMap, o: EnvCheckOptions): Check[] {
  const out: Check[] = [];
  const t = o.target;
  out.push(...prodGuardChecks(env, o));
  out.push(...dbChecks(env, o));

  // Upstash: either the Vercel KV names or the raw Upstash names.
  const kv = ["KV_REST_API_URL", "KV_REST_API_TOKEN"];
  const up = ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"];
  const havePair = (p: string[]) => p.every((n) => n in env && (!isPlaceholder(env[n]) || sensitiveBlank(env, n, o.pulled)));
  if (havePair(kv) || havePair(up)) {
    out.push({ id: "KV_REST_API_URL/TOKEN", status: "PASS", detail: `set (${havePair(kv) ? "KV_*" : "UPSTASH_*"} names)` });
  } else {
    out.push({
      id: "KV_REST_API_URL/TOKEN",
      status: "MISSING",
      detail: "no complete Upstash pair",
      fix: "Vercel: Storage, Create, Upstash for Redis, connect to the app project. It sets both names.",
    });
  }

  out.push(requireName(env, "CH_API_KEY", o, `Copy from .env.local: ${addHint(t, "CH_API_KEY")}`));
  out.push(requireName(env, "LLM_PROVIDER", o, `printf %s anthropic | ${addHint(t, "LLM_PROVIDER")}`));
  out.push(requireName(env, "LLM_MODEL", o, `Copy from .env.local: ${addHint(t, "LLM_MODEL")}`));
  out.push(requireName(env, "LLM_API_KEY", o, `Copy from .env.local: ${addHint(t, "LLM_API_KEY")}`));

  // Smoke secrets are for the machine that runs scripts/smoke-prod.ts, not for the deployment.
  for (const name of ["SMOKE_EMAIL", "SMOKE_PASSWORD", "SMOKE_BYPASS_TOKEN"]) {
    if (o.pulled) {
      out.push(
        name in env
          ? { id: name, status: "WARN", detail: "present in Vercel", fix: "The smoke reads it from .env.local. It need not be in Vercel. Remove it." }
          : { id: name, status: "PASS", detail: "local only, not expected in Vercel (check .env.local)" },
      );
    } else {
      const fix =
        name === "SMOKE_BYPASS_TOKEN"
          ? "Vercel project, Settings, Deployment Protection, Protection Bypass for Automation. Put the secret in .env.local."
          : name === "SMOKE_EMAIL"
            ? "The preview user's email, in .env.local."
            : "The preview user's throwaway password, in .env.local.";
      out.push(requireName(env, name, o, fix));
    }
  }

  // Mail (WP-DS08). Needed once invites (WP-DS05) and demo confirmations (WP-SS06) send from the
  // host. A preview can boot without them, so they warn there and block production.
  for (const name of MAIL_NAMES) {
    const r = requireName(env, name, o, mailFix(name, t));
    if (r.status === "MISSING" && t === "preview") {
      out.push({ ...r, status: "WARN", detail: `${r.detail} (blocks production, not the preview)` });
    } else if (r.status === "PASS" && name.startsWith("MAIL_") && !looksLikeMailbox(env[name])) {
      out.push({ id: name, status: "FAIL", detail: "set, but not an email address or Name <address>", fix: mailFix(name, t) });
    } else {
      out.push(r);
    }
  }

  // A pulled file names its own environment. Catch a preview file checked as production.
  if (o.pulled && env.VERCEL_ENV && env.VERCEL_ENV !== t) {
    out.push({
      id: "VERCEL_ENV",
      status: "FAIL",
      detail: `the file was pulled from ${env.VERCEL_ENV}, the target is ${t}`,
      fix: `vercel env pull --environment=${t} .env.${t}.pulled`,
    });
  }
  return out;
}

function mailFix(name: string, t: Target): string {
  switch (name) {
    case "RESEND_API_KEY":
      return `Resend, API Keys, Create (sending access, the brand domain only). ${addHint(t, "RESEND_API_KEY")}`;
    case "MAIL_FROM_INVITES":
      return `e.g. "Tearline <invites@DOMAIN>". ${addHint(t, "MAIL_FROM_INVITES")}`;
    case "MAIL_FROM_DEMO":
      return `e.g. "Tearline <demo@DOMAIN>". ${addHint(t, "MAIL_FROM_DEMO")}`;
    default:
      return `The inbox that receives demo requests, e.g. cam@DOMAIN. ${addHint(t, "MAIL_DEMO_INBOX")}`;
  }
}

function looksLikeMailbox(v: string): boolean {
  return /^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/.test(v.trim()) || /^[^<>]*<[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+>$/.test(v.trim());
}

// ---------------------------------------------------------------------------------------------
// Repo checks

export interface RepoFiles {
  productPackageJson: string | null;
  productVercelJson: string | null;
  runRoute: string | null; // product/app/api/run/route.ts
  narrativeVercelJson: string | null;
  narrativeNextConfig: string | null;
}

function parseJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function regionCheck(id: string, text: string | null): Check {
  const j = parseJson(text);
  if (!j) return { id, status: "MISSING", detail: "file missing or not JSON", fix: 'Add "regions": ["lhr1"].' };
  const regions = Array.isArray(j.regions) ? (j.regions as unknown[]).map(String) : [];
  if (regions.length === 1 && regions[0] === "lhr1") return { id, status: "PASS", detail: "regions [lhr1]" };
  return { id, status: "FAIL", detail: `regions [${regions.join(", ")}]`, fix: 'Set "regions": ["lhr1"] (London, next to the database).' };
}

export function checkRepo(f: RepoFiles): Check[] {
  const out: Check[] = [];

  const pkg = parseJson(f.productPackageJson);
  const deps = (pkg?.dependencies ?? {}) as Record<string, string>;
  out.push(
    deps.postgres
      ? { id: "repo: postgres dependency", status: "PASS", detail: `postgres ${deps.postgres} in dependencies` }
      : {
          id: "repo: postgres dependency",
          status: "MISSING",
          detail: "postgres is not in product/package.json dependencies",
          fix: "Merge WP-DS01 (npm install postgres in product/). Without it the first database call fails.",
        },
  );

  out.push(regionCheck("repo: product/vercel.json region", f.productVercelJson));
  out.push(regionCheck("repo: sites/narrative/vercel.json region", f.narrativeVercelJson));

  // maxDuration on the run route: in the route file (the house choice) or in vercel.json.
  const fileMax = f.runRoute ? /export\s+const\s+maxDuration\s*=\s*(\d+)/.exec(f.runRoute) : null;
  const fns = (parseJson(f.productVercelJson)?.functions ?? {}) as Record<string, { maxDuration?: number }>;
  const jsonMax = fns["app/api/run/route.ts"]?.maxDuration;
  const max = fileMax ? Number(fileMax[1]) : jsonMax;
  if (max === undefined) {
    out.push({
      id: "repo: /api/run maxDuration",
      status: "MISSING",
      detail: "no maxDuration on app/api/run/route.ts",
      fix: "export const maxDuration = 300 in the route file. The default kills a run mid-stage.",
    });
  } else if (max < 120) {
    out.push({ id: "repo: /api/run maxDuration", status: "WARN", detail: `${max} s, a scanned filing takes up to 120 s`, fix: "Raise it to 300." });
  } else {
    out.push({ id: "repo: /api/run maxDuration", status: "PASS", detail: `${max} s (${fileMax ? "route file" : "vercel.json"})` });
  }

  // The narrative site must not be indexed off production.
  const nc = f.narrativeNextConfig ?? "";
  if (/X-Robots-Tag/i.test(nc) && /VERCEL_ENV/.test(nc) && /noindex/i.test(nc)) {
    out.push({ id: "repo: narrative noindex off production", status: "PASS", detail: "next.config.ts sends X-Robots-Tag noindex unless VERCEL_ENV is production" });
  } else {
    out.push({
      id: "repo: narrative noindex off production",
      status: "WARN",
      detail: "relies on Vercel's automatic noindex on preview hosts. The layout says index",
      fix: "Check the X-Robots-Tag header on the preview host once.",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// /api/health

export function checkHealth(httpStatus: number, body: unknown, target: Target): Check[] {
  if (httpStatus === 401 || httpStatus === 403) {
    return [
      {
        id: "health: reachable",
        status: "FAIL",
        detail: `HTTP ${httpStatus}, Deployment Protection answered`,
        fix: "Set SMOKE_BYPASS_TOKEN in the env file to the project's Protection Bypass for Automation secret.",
      },
    ];
  }
  if (httpStatus !== 200 || !body || typeof body !== "object") {
    return [{ id: "health: reachable", status: "FAIL", detail: `HTTP ${httpStatus}, no JSON body`, fix: "Is the URL the app host? Read the function log for /api/health." }];
  }
  const b = body as Record<string, unknown>;
  const out: Check[] = [{ id: "health: reachable", status: "PASS", detail: `HTTP 200, commit ${String(b.commit ?? "unknown").slice(0, 12)}` }];

  const want = (id: string, key: string, expected: unknown, fix: string) => {
    const got = b[key];
    if (got === undefined) out.push({ id, status: "MISSING", detail: `no ${key} field in the health body`, fix });
    else if (got === expected) out.push({ id, status: "PASS", detail: `${key} ${String(got)}` });
    else out.push({ id, status: "FAIL", detail: `${key} ${String(got)}, want ${String(expected)}`, fix });
  };

  want(
    "health: ready",
    "ready",
    true,
    "A production-required variable is missing or the role is unsafe. The name is in the boot log.",
  );
  if (target === "preview" && b.ready === true) {
    out[out.length - 1].detail += " (a preview is always ready unless dbRoleSafe is false. Rely on the env rows)";
  }
  want("health: storeDurable", "storeDurable", true, "APP_DATABASE_URL is not set in the scope that deployed, or postgres is not installed.");
  want("health: cacheBackend", "cacheBackend", "upstash", "The Upstash variables are missing in this scope.");
  want("health: dataMode", "dataMode", "live", "CH_API_KEY is not set in this scope.");
  want(
    "health: dbRoleSafe",
    "dbRoleSafe",
    true,
    b.dbRoleSafe === undefined
      ? "The deploy predates WP-DS02's role guard. Deploy a build that carries it."
      : "The app connects as a superuser, a BYPASSRLS role or a table owner. Point APP_DATABASE_URL at app_user.",
  );
  if (b.llm !== undefined && b.llm !== "on") {
    out.push({ id: "health: llm", status: "WARN", detail: `llm ${String(b.llm)}`, fix: "Set LLM_PROVIDER, LLM_MODEL, LLM_API_KEY in this scope. Scanned filings abstain without them." });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Database role facts (read as the app's own connection)

export interface DbFacts {
  currentUser: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  ownedTables: number;
  latestMigration: string | null; // null when schema_migrations exists but is empty
  migrationsError?: string; // why schema_migrations could not be read
}

export function checkDbFacts(f: DbFacts): Check[] {
  const out: Check[] = [];
  out.push(
    f.currentUser === "app_user"
      ? { id: "db: current_user", status: "PASS", detail: "app_user" }
      : { id: "db: current_user", status: "FAIL", detail: f.currentUser, fix: "APP_DATABASE_URL must log in as app_user." },
  );
  out.push(
    f.rolsuper
      ? { id: "db: rolsuper", status: "FAIL", detail: "true", fix: "ALTER ROLE app_user NOSUPERUSER (as the owner)." }
      : { id: "db: rolsuper", status: "PASS", detail: "false" },
  );
  out.push(
    f.rolbypassrls
      ? { id: "db: rolbypassrls", status: "FAIL", detail: "true", fix: "ALTER ROLE app_user NOBYPASSRLS (as the owner)." }
      : { id: "db: rolbypassrls", status: "PASS", detail: "false" },
  );
  out.push(
    f.ownedTables > 0
      ? {
          id: "db: owns no table",
          status: "FAIL",
          detail: `owns ${f.ownedTables} table(s)`,
          fix: "A table owner bypasses its own RLS. Re-run db-migrate as the owner so the owner creates the tables.",
        }
      : { id: "db: owns no table", status: "PASS", detail: "owns 0 tables" },
  );
  if (f.migrationsError) {
    out.push({
      id: "db: schema_migrations",
      status: "WARN",
      detail: `not readable as this role (${f.migrationsError})`,
      fix: "Read it as the owner: psql \"$OWNER_DATABASE_URL\" -c 'select * from schema_migrations'.",
    });
  } else if (f.latestMigration === null) {
    out.push({ id: "db: schema_migrations", status: "MISSING", detail: "empty", fix: "Run npx tsx scripts/db-migrate.ts with OWNER_DATABASE_URL." });
  } else {
    out.push({ id: "db: schema_migrations", status: "PASS", detail: `latest ${f.latestMigration}` });
  }
  return out;
}

// Picks the latest migration name from schema_migrations rows without knowing the column names:
// the first string column that looks like a migration file name (0001_init or 0001_init.sql).
export function latestMigrationFrom(rows: Array<Record<string, unknown>>): string | null {
  const names: string[] = [];
  for (const r of rows) {
    for (const v of Object.values(r)) {
      if (typeof v === "string" && /^\d{3,}[_-]/.test(v)) {
        names.push(v);
        break;
      }
    }
  }
  if (!names.length) return rows.length ? `${rows.length} row(s), no file-like name column` : null;
  return names.sort().at(-1) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Rendering and verdict

export function exitCode(checks: Check[]): number {
  return checks.some((c) => c.status === "MISSING" || c.status === "FAIL") ? 1 : 0;
}

export function renderTable(checks: Check[]): string {
  const w = Math.max(5, ...checks.map((c) => c.id.length));
  const lines: string[] = [];
  lines.push(`${"STATUS".padEnd(8)} ${"CHECK".padEnd(w)}  DETAIL`);
  for (const c of checks) {
    lines.push(`${c.status.padEnd(8)} ${c.id.padEnd(w)}  ${c.detail}`);
    if (c.status !== "PASS" && c.fix) lines.push(`${"".padEnd(8)} ${"".padEnd(w)}  -> ${c.fix}`);
  }
  const n = (s: Status) => checks.filter((c) => c.status === s).length;
  lines.push("");
  lines.push(`${n("PASS")} pass, ${n("WARN")} warn, ${n("MISSING")} missing, ${n("FAIL")} fail. ${exitCode(checks) === 0 ? "READY" : "NOT READY"}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Arguments

export interface PreflightArgs {
  target: Target;
  envFile: string;
  url: string | null;
  db: boolean;
  json: boolean;
  help: boolean;
  errors: string[];
}

export function parseArgs(argv: string[]): PreflightArgs {
  const a: PreflightArgs = { target: "preview", envFile: ".env.local", url: null, db: false, json: false, help: false, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) a.errors.push(`${k} needs a value`);
      return v ?? "";
    };
    if (k === "--target") {
      const v = next();
      if (v === "preview" || v === "production") a.target = v;
      else a.errors.push(`--target must be preview or production`);
    } else if (k === "--env-file") a.envFile = next();
    else if (k === "--url") {
      const v = next().replace(/\/+$/, "");
      if (!/^https?:\/\//.test(v)) a.errors.push("--url must start with http:// or https://");
      a.url = v;
    } else if (k === "--db") a.db = true;
    else if (k === "--json") a.json = true;
    else if (k === "--help" || k === "-h") a.help = true;
    else a.errors.push(`unknown argument ${k}`);
  }
  return a;
}
