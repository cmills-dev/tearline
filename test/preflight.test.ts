// test/preflight.test.ts (WP-DS04, WP-DS08)
// Drives the pure checks in lib/release/preflight.ts: env names and placeholders, the app_user
// rule, local-only secrets in a Vercel pull, the repo checks, the health body and the role facts.
// Every case also proves that no secret value reaches the printed table.

import {
  checkDbFacts,
  checkEnv,
  checkHealth,
  checkRepo,
  describeDbUrl,
  exitCode,
  isPlaceholder,
  latestMigrationFrom,
  looksPulled,
  parseArgs,
  parseEnvFile,
  renderTable,
  type Check,
  type EnvMap,
} from "../lib/release/preflight";
import { suite, test, assert, assertEqual } from "./harness";

const SECRET = "s3cr3t-value-that-must-never-print-0123456789";
const APP_URL = `postgresql://app_user:${SECRET}@ep-cool-1.eu-west-2.aws.neon.tech/neondb?sslmode=require`;
const OWNER_URL = `postgresql://neondb_owner:${SECRET}@ep-cool-1.eu-west-2.aws.neon.tech/neondb?sslmode=require`;

function fullEnv(): EnvMap {
  return {
    AUTH_SECRET: SECRET,
    AUTH_REQUIRED: "1",
    SHARED_HASH_PEPPER: SECRET,
    CRON_SECRET: SECRET,
    SHARED_ADMIN_SECRET: SECRET,
    APP_DATABASE_URL: APP_URL,
    KV_REST_API_URL: "https://eu1-x.upstash.io",
    KV_REST_API_TOKEN: SECRET,
    CH_API_KEY: SECRET,
    LLM_PROVIDER: "anthropic",
    LLM_MODEL: "claude-opus-4-8",
    LLM_API_KEY: SECRET,
    SMOKE_EMAIL: "smoke@example.com",
    SMOKE_PASSWORD: SECRET,
    SMOKE_BYPASS_TOKEN: SECRET,
    RESEND_API_KEY: SECRET,
    MAIL_FROM_INVITES: "Tearline <invites@example.com>",
    MAIL_FROM_DEMO: "demo@example.com",
    MAIL_DEMO_INBOX: "cam@example.com",
    OWNER_DATABASE_URL: OWNER_URL,
  };
}

const find = (cs: Check[], id: string) => cs.find((c) => c.id === id);
const statusOf = (cs: Check[], id: string) => find(cs, id)?.status;
const noSecret = (cs: Check[]) => !renderTable(cs).includes(SECRET) && !JSON.stringify(cs).includes(SECRET);

suite("preflight: env files");

test("parses quotes, export, comments and blanks", () => {
  const e = parseEnvFile(`# Created by Vercel CLI\nexport A=1\nB="two words"\nC='x#y'\nD=plain # note\nE=""\n\n`);
  assertEqual(e.A, "1", "export prefix");
  assertEqual(e.B, "two words", "double quotes");
  assertEqual(e.C, "x#y", "single quotes keep #");
  assertEqual(e.D, "plain", "inline comment dropped");
  assertEqual(e.E, "", "empty kept as present");
});

test("detects a vercel pull by header, VERCEL_ENV or file name", () => {
  assert(looksPulled("# Created by Vercel CLI\nA=1", ".env.x"), "header");
  assert(looksPulled('VERCEL_ENV="preview"', ".env.x"), "VERCEL_ENV");
  assert(looksPulled("A=1", ".env.preview.pulled"), "name");
  assert(!looksPulled("A=1", ".env.local"), "local file");
});

test("placeholders are caught", () => {
  for (const v of ["", "  ", "CHANGE_ME", "<your key>", "sk-ant-...", "xxx", "your-key", "postgres://user:password@host:5432/dbname"]) {
    assert(isPlaceholder(v), `placeholder: ${v}`);
  }
  assert(!isPlaceholder("anthropic"), "a real value");
});

test("describeDbUrl gives user and host only", () => {
  const p = describeDbUrl(APP_URL);
  assertEqual(p?.user, "app_user", "user");
  assertEqual(p?.host, "ep-cool-1.eu-west-2.aws.neon.tech", "host");
  assert(!JSON.stringify(p).includes(SECRET), "no password in the parts");
  assertEqual(describeDbUrl("https://x"), null, "not postgres");
  assert(describeDbUrl("postgres://app_user:CHANGE_ME@h/db")?.passwordPlaceholder === true, "CHANGE_ME password");
});

suite("preflight: env checks");

test("a complete local file is ready and prints no value", () => {
  const cs = checkEnv(fullEnv(), { target: "preview", pulled: false });
  assertEqual(exitCode(cs), 0, renderTable(cs));
  assert(noSecret(cs), "no secret in output");
  assert(find(cs, "APP_DATABASE_URL")!.detail.includes("ep-cool-1"), "host printed");
});

test("an empty file is missing every required name", () => {
  const cs = checkEnv({}, { target: "preview", pulled: false });
  assertEqual(exitCode(cs), 1, "not ready");
  for (const id of ["AUTH_SECRET", "AUTH_REQUIRED", "SHARED_HASH_PEPPER", "CRON_SECRET", "SHARED_ADMIN_SECRET", "APP_DATABASE_URL", "KV_REST_API_URL/TOKEN", "CH_API_KEY", "LLM_API_KEY", "SMOKE_BYPASS_TOKEN"]) {
    assertEqual(statusOf(cs, id), "MISSING", id);
  }
  assertEqual(statusOf(cs, "RESEND_API_KEY"), "WARN", "mail warns on a preview");
  assertEqual(statusOf(cs, "OWNER_DATABASE_URL"), "WARN", "owner URL advised locally");
});

test("mail blocks production", () => {
  const cs = checkEnv({}, { target: "production", pulled: false });
  assertEqual(statusOf(cs, "RESEND_API_KEY"), "MISSING", "production");
});

test("AUTH_SECRET strength mirrors prodGuard", () => {
  const short = checkEnv({ ...fullEnv(), AUTH_SECRET: "short" }, { target: "preview", pulled: false });
  assertEqual(statusOf(short, "AUTH_SECRET"), "MISSING", "short secret");
  const dev = checkEnv({ ...fullEnv(), AUTH_SECRET: "dev-insecure-secret-set-AUTH_SECRET" }, { target: "preview", pulled: false });
  assertEqual(statusOf(dev, "AUTH_SECRET"), "MISSING", "dev fallback");
  const pep = checkEnv({ ...fullEnv(), SHARED_HASH_PEPPER: "dev-shared-pepper" }, { target: "preview", pulled: false });
  assertEqual(statusOf(pep, "SHARED_HASH_PEPPER"), "MISSING", "dev pepper");
  const ar = checkEnv({ ...fullEnv(), AUTH_REQUIRED: "true" }, { target: "preview", pulled: false });
  assertEqual(statusOf(ar, "AUTH_REQUIRED"), "MISSING", "must be exactly 1");
});

test("APP_DATABASE_URL must be app_user with a real password", () => {
  const owner = checkEnv({ ...fullEnv(), APP_DATABASE_URL: OWNER_URL }, { target: "preview", pulled: false });
  assertEqual(statusOf(owner, "APP_DATABASE_URL"), "FAIL", "owner as app URL");
  assert(find(owner, "APP_DATABASE_URL")!.detail.includes("neondb_owner"), "names the user");
  assert(noSecret(owner), "no secret");
  const cm = checkEnv({ ...fullEnv(), APP_DATABASE_URL: "postgres://app_user:CHANGE_ME@h/db" }, { target: "preview", pulled: false });
  assertEqual(statusOf(cm, "APP_DATABASE_URL"), "MISSING", "CHANGE_ME counts as a placeholder");
});

test("an owner DATABASE_URL warns when APP_DATABASE_URL is set and fails alone", () => {
  const both = checkEnv({ ...fullEnv(), DATABASE_URL: OWNER_URL, POSTGRES_URL: OWNER_URL }, { target: "preview", pulled: true });
  assertEqual(statusOf(both, "DATABASE_URL"), "WARN", "APP_DATABASE_URL wins");
  assertEqual(statusOf(both, "POSTGRES_URL"), "WARN", "same for POSTGRES_URL");
  const env = fullEnv();
  delete env.APP_DATABASE_URL;
  const alone = checkEnv({ ...env, DATABASE_URL: OWNER_URL }, { target: "preview", pulled: false });
  assertEqual(statusOf(alone, "DATABASE_URL"), "FAIL", "owner is the only DB var");
  assert(noSecret(alone), "no secret");
});

test("local-only secrets fail in a Vercel pull", () => {
  const cs = checkEnv({ ...fullEnv(), APP_USER_PASSWORD: SECRET }, { target: "preview", pulled: true });
  assertEqual(statusOf(cs, "OWNER_DATABASE_URL"), "FAIL", "owner URL in Vercel");
  assertEqual(statusOf(cs, "APP_USER_PASSWORD"), "FAIL", "app_user password in Vercel");
  assertEqual(statusOf(cs, "SMOKE_PASSWORD"), "WARN", "smoke secrets need not be in Vercel");
  const env = fullEnv();
  delete env.OWNER_DATABASE_URL;
  for (const k of ["SMOKE_EMAIL", "SMOKE_PASSWORD", "SMOKE_BYPASS_TOKEN"]) delete env[k];
  const clean = checkEnv(env, { target: "preview", pulled: true });
  assertEqual(exitCode(clean), 0, renderTable(clean));
});

test("a blank value in a pull is a sensitive-variable warning, not a pass", () => {
  const cs = checkEnv({ ...fullEnv(), AUTH_SECRET: "", CH_API_KEY: "" }, { target: "preview", pulled: true });
  assertEqual(statusOf(cs, "AUTH_SECRET"), "WARN", "sensitive AUTH_SECRET");
  assertEqual(statusOf(cs, "CH_API_KEY"), "WARN", "sensitive CH key");
});

test("a pull from the wrong environment fails", () => {
  const cs = checkEnv({ ...fullEnv(), VERCEL_ENV: "preview" }, { target: "production", pulled: true });
  assertEqual(statusOf(cs, "VERCEL_ENV"), "FAIL", "preview file checked as production");
});

test("a from address must look like a mailbox", () => {
  const cs = checkEnv({ ...fullEnv(), MAIL_FROM_INVITES: "invites" }, { target: "preview", pulled: false });
  assertEqual(statusOf(cs, "MAIL_FROM_INVITES"), "FAIL", "not an address");
});

test("the raw Upstash names are accepted", () => {
  const env = fullEnv();
  delete env.KV_REST_API_URL;
  delete env.KV_REST_API_TOKEN;
  const cs = checkEnv({ ...env, UPSTASH_REDIS_REST_URL: "https://x.upstash.io", UPSTASH_REDIS_REST_TOKEN: SECRET }, { target: "preview", pulled: false });
  assertEqual(statusOf(cs, "KV_REST_API_URL/TOKEN"), "PASS", "UPSTASH_* pair");
});

suite("preflight: repo checks");

const goodRepo = {
  productPackageJson: JSON.stringify({ dependencies: { postgres: "^3.4.5" } }),
  productVercelJson: JSON.stringify({ regions: ["lhr1"] }),
  runRoute: "export const maxDuration = 300;",
  narrativeVercelJson: JSON.stringify({ regions: ["lhr1"] }),
  narrativeNextConfig: 'if (process.env.VERCEL_ENV !== "production") { key: "X-Robots-Tag", value: "noindex" }',
};

test("a good repo passes", () => {
  const cs = checkRepo(goodRepo);
  assertEqual(exitCode(cs), 0, renderTable(cs));
  assert(cs.every((c) => c.status === "PASS"), renderTable(cs));
});

test("no postgres, wrong region and no maxDuration are caught", () => {
  const cs = checkRepo({ ...goodRepo, productPackageJson: "{}", productVercelJson: JSON.stringify({ regions: ["iad1"] }), runRoute: "" });
  assertEqual(statusOf(cs, "repo: postgres dependency"), "MISSING", "postgres");
  assertEqual(statusOf(cs, "repo: product/vercel.json region"), "FAIL", "region");
  assertEqual(statusOf(cs, "repo: /api/run maxDuration"), "MISSING", "maxDuration");
});

test("maxDuration in vercel.json counts, and no noindex story warns", () => {
  const cs = checkRepo({
    ...goodRepo,
    runRoute: "",
    productVercelJson: JSON.stringify({ regions: ["lhr1"], functions: { "app/api/run/route.ts": { maxDuration: 300 } } }),
    narrativeNextConfig: "",
  });
  assertEqual(statusOf(cs, "repo: /api/run maxDuration"), "PASS", "vercel.json");
  assertEqual(statusOf(cs, "repo: narrative noindex off production"), "WARN", "no header");
});

suite("preflight: health");

const goodHealth = { ready: true, storeDurable: true, cacheBackend: "upstash", dataMode: "live", dbRoleSafe: true, llm: "on", commit: "abc" };

test("a healthy body passes", () => {
  assertEqual(exitCode(checkHealth(200, goodHealth, "production")), 0, "healthy");
});

test("each unhealthy field is caught", () => {
  const cs = checkHealth(200, { ...goodHealth, storeDurable: false, cacheBackend: "memory", dataMode: "fixtures", dbRoleSafe: false, ready: false }, "preview");
  for (const id of ["health: ready", "health: storeDurable", "health: cacheBackend", "health: dataMode", "health: dbRoleSafe"]) {
    assertEqual(statusOf(cs, id), "FAIL", id);
  }
});

test("a deploy without the role guard is missing dbRoleSafe", () => {
  const { dbRoleSafe: _drop, ...old } = goodHealth;
  assertEqual(statusOf(checkHealth(200, old, "preview"), "health: dbRoleSafe"), "MISSING", "no field");
});

test("protection and non-JSON answers fail", () => {
  assertEqual(statusOf(checkHealth(401, null, "preview"), "health: reachable"), "FAIL", "401");
  assertEqual(statusOf(checkHealth(500, null, "preview"), "health: reachable"), "FAIL", "500");
});

suite("preflight: database role");

test("a safe app_user passes", () => {
  const cs = checkDbFacts({ currentUser: "app_user", rolsuper: false, rolbypassrls: false, ownedTables: 0, latestMigration: "0013_x.sql" });
  assertEqual(exitCode(cs), 0, renderTable(cs));
});

test("owner, superuser, bypassrls and table ownership fail", () => {
  const cs = checkDbFacts({ currentUser: "neondb_owner", rolsuper: true, rolbypassrls: true, ownedTables: 15, latestMigration: null });
  for (const id of ["db: current_user", "db: rolsuper", "db: rolbypassrls", "db: owns no table"]) assertEqual(statusOf(cs, id), "FAIL", id);
  assertEqual(statusOf(cs, "db: schema_migrations"), "MISSING", "empty table");
});

test("an unreadable schema_migrations warns", () => {
  const cs = checkDbFacts({ currentUser: "app_user", rolsuper: false, rolbypassrls: false, ownedTables: 0, latestMigration: null, migrationsError: "error 42501" });
  assertEqual(statusOf(cs, "db: schema_migrations"), "WARN", "permission denied");
});

test("latestMigrationFrom finds the newest file-like name", () => {
  assertEqual(latestMigrationFrom([{ id: 1, name: "0002_b.sql" }, { id: 2, name: "0011_k.sql" }, { id: 3, name: "0003_c.sql" }]), "0011_k.sql", "max");
  assertEqual(latestMigrationFrom([]), null, "empty");
});

suite("preflight: arguments");

test("defaults and flags", () => {
  const d = parseArgs([]);
  assertEqual(d.target, "preview", "default target");
  assertEqual(d.envFile, ".env.local", "default env file");
  const a = parseArgs(["--target", "production", "--env-file", ".env.p", "--url", "https://x.vercel.app/", "--db"]);
  assertEqual(a.target, "production", "target");
  assertEqual(a.url, "https://x.vercel.app", "trailing slash trimmed");
  assert(a.db && a.errors.length === 0, "db, no errors");
  assert(parseArgs(["--target", "staging"]).errors.length === 1, "bad target");
  assert(parseArgs(["--url", "x.app"]).errors.length === 1, "bad url");
  assert(parseArgs(["--password", "x"]).errors.length >= 1, "unknown flag");
});
