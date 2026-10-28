// test/ds05.test.ts (WP-DS05, DSD-12)
// Invite-only registration, the failed-login gate, and the add-user script.
//
// No network and no database. The Postgres auth store runs its real SQL against pg-mem, over
// the real CREATE TABLE statements lifted from 0001, 0002 and 0014. pg-mem does not enforce
// row-level security, so the RLS policy itself is checked as text. The routes are called
// directly, as test/qa03.test.ts does; the success path of register needs a request context for
// its cookies, so it is proven through registerUser, which the route calls.
// The add-user script is driven through runAddUser with an in-memory store. global fetch is
// replaced by a counter for every add-user case, to prove nothing leaves the process.

import { readdirSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { pgMemAuthSql } from "./authWallDouble";
import { suite, test, assert, assertEqual } from "./harness";
import { POST as login } from "../app/api/auth/login/route";
import { POST as register } from "../app/api/auth/register/route";
import { getRateLimiter, InMemoryRateLimiter, resetRateLimiterForTests } from "../lib/ratelimit/ratelimit";
import {
  getAuthStore,
  InMemoryAuthStore,
  PostgresAuthStore,
  resetAuthStoreForTests,
  setAuthSqlForTests,
  type AuthStore,
  type Sql,
} from "../lib/auth/store";
import { hashPassword, inviteTokenHash, verifyPassword } from "../lib/auth/crypto";
import {
  INVITE_INVALID_MESSAGE,
  INVITE_REQUIRED_MESSAGE,
  registerUser,
  registrationMode,
} from "../lib/auth/registration";
import { LOGIN_FAILURES, loginBlockedFor, loginFailureKey, recordLoginFailure } from "../lib/auth/loginLimit";
import { addUser, parseAddUserArgs, renderInviteEmail, runAddUser } from "../lib/auth/invite";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "db", "migrations");
const read = (f: string) => readFileSync(join(MIGRATIONS, f), "utf8");
const INVITE_SQL = read("0014_invites.sql");

const PROD: NodeJS.ProcessEnv = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
const DEV: NodeJS.ProcessEnv = { NODE_ENV: "development" } as NodeJS.ProcessEnv;
const env = (vars: Record<string, string>): NodeJS.ProcessEnv => vars as unknown as NodeJS.ProcessEnv;
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-27T09:00:00Z");

// ---- helpers ---------------------------------------------------------------------------------

// pg-mem behind the tagged-template shape PostgresAuthStore calls. Since the auth wall (0015) the
// store calls SECURITY DEFINER functions, which pg-mem cannot run, so test/authWallDouble.ts
// rewrites each call into its body's SQL. See that file for what this does and does not prove.
function pgMemSql(): Sql {
  return pgMemAuthSql().sql;
}

const post = (url: string, body: unknown, ip = "203.0.113.7") =>
  new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-real-ip": ip } });

async function withEnv<T>(patch: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const env = process.env as Record<string, string | undefined>;
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(patch)) {
    saved[k] = env[k];
    if (patch[k] === undefined) delete env[k];
    else env[k] = patch[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete env[k];
      else env[k] = saved[k];
    }
  }
}

async function noNetwork<T>(fn: () => Promise<T>): Promise<{ value: T; calls: number }> {
  const saved = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error("network is off in this test");
  }) as typeof fetch;
  try {
    return { value: await fn(), calls };
  } finally {
    globalThis.fetch = saved;
  }
}

function tokenFrom(lines: string[]): string {
  const link = lines.find((l) => l.startsWith("Link: "));
  if (!link) throw new Error(`no link in: ${lines.join(" | ")}`);
  return decodeURIComponent(new URL(link.slice("Link: ".length)).searchParams.get("invite") ?? "");
}

// The same store contract, run against both stores.
async function storeContract(store: AuthStore): Promise<Record<string, unknown>> {
  const demo = await store.createTenant("Demo");
  const first = await store.createUser("first@desk.com", hashPassword("first password"), demo.id);
  const byName = await store.findTenant("DEMO");
  const unknown = await store.findTenant("nobody");
  const { token, invite } = await store.createInvite(demo.id, "Second@Desk.com", new Date(NOW.getTime() + 7 * DAY));
  const wrongEmail = await store.redeemInvite(token, "someone@else.com", hashPassword("x"), NOW);
  const expired = await store.redeemInvite(token, "second@desk.com", hashPassword("x"), new Date(NOW.getTime() + 8 * DAY));
  const bogus = await store.redeemInvite("not-a-token", "second@desk.com", hashPassword("x"), NOW);
  const ok = await store.redeemInvite(token, "second@desk.com", hashPassword("second password"), NOW);
  const again = await store.redeemInvite(token, "second@desk.com", hashPassword("x"), NOW);
  const second = await store.findUserByEmail("second@desk.com");
  const { token: t2 } = await store.createInvite(demo.id, "first@desk.com", new Date(NOW.getTime() + DAY));
  const exists = await store.redeemInvite(t2, "first@desk.com", hashPassword("x"), NOW);
  let dupTenant = false;
  try {
    await store.createTenant("demo");
  } catch {
    dupTenant = true;
  }
  return { demo, first, byName, unknown, token, invite, wrongEmail, expired, bogus, ok, again, second, exists, dupTenant };
}

export async function registerDs05Tests(): Promise<void> {
  // ---- The migration ---------------------------------------------------------------------------
  suite("WP-DS05 migration: 0014_invites.sql");

  test("an invite table keyed to a tenant, storing a token hash and never the token", () => {
    assert(INVITE_SQL.includes("create table if not exists invite"), "create table if not exists");
    assert(INVITE_SQL.includes("tenant_id   text not null references tenant(id) on delete cascade"), "tenant foreign key with cascade");
    assert(/token_hash\s+text unique not null/.test(INVITE_SQL), "a unique token hash");
    assert(!/\btoken\s+text/.test(INVITE_SQL), "no raw token column");
    assert(/expires_at\s+timestamptz not null/.test(INVITE_SQL) && /used_at\s+timestamptz/.test(INVITE_SQL), "expiry and single use");
  });

  test("row-level security is enabled, forced and scoped like the other tenant tables", () => {
    assert(INVITE_SQL.includes("alter table invite enable row level security"), "enabled");
    assert(INVITE_SQL.includes("alter table invite force  row level security"), "forced");
    assert(INVITE_SQL.includes("drop policy if exists invite_tenant on invite"), "idempotent");
    assert(
      /using \(tenant_id = current_setting\('app\.tenant_id', true\)\s+or token_hash = current_setting\('app\.invite_hash', true\)\)/.test(INVITE_SQL),
      "visible to its tenant, or by its own token hash",
    );
    assert(INVITE_SQL.includes("with check (tenant_id = current_setting('app.tenant_id', true))"), "writes need the tenant");
    assert(INVITE_SQL.includes("grant select, insert, update, delete on invite to app_user"), "the app role is granted the table");
    assert(/if exists \(select 1 from pg_roles where rolname = 'app_user'\)/.test(INVITE_SQL), "only when the role exists (roles.sql covers a fresh database)");
  });

  test("0014 comes after 0013 and matches the runner's file pattern", () => {
    const names = readdirSync(MIGRATIONS).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
    assertEqual(names[names.indexOf("0014_invites.sql") - 1]?.slice(0, 4), "0013", "right after 0013");
    assertEqual(names.filter((f) => f.startsWith("0014_")).length, 1, "no other 0014");
  });

  // ---- The stores --------------------------------------------------------------------------------
  const mem = await storeContract(new InMemoryAuthStore());
  const pgSql = pgMemSql();
  setAuthSqlForTests(pgSql);
  let pg: Record<string, unknown>;
  let pgRow: Record<string, unknown> | undefined;
  try {
    pg = await storeContract(new PostgresAuthStore());
    pgRow = (await pgSql`select * from invite where email = ${"second@desk.com"}`)[0];
  } finally {
    setAuthSqlForTests(null);
  }

  for (const [name, r, row] of [
    ["in-memory", mem, undefined],
    ["Postgres over pg-mem", pg, pgRow],
  ] as const) {
    suite(`WP-DS05 store (${name}): invites join a named tenant`);
    test("a named tenant gets its slug as id and is found by name", () => {
      assertEqual((r.demo as { id: string }).id, "demo", "Demo becomes demo");
      assertEqual((r.byName as { id: string } | null)?.id, "demo", "found case-insensitively by name");
      assertEqual(r.unknown, null, "an unknown name is null");
      assert(r.dupTenant, "the same tenant cannot be made twice");
    });
    test("a valid invite makes a second user in the invite's tenant", () => {
      const ok = r.ok as { ok: boolean; user?: { tenantId: string; email: string; passwordHash: string } };
      assert(ok.ok, `redeemed: ${JSON.stringify(ok)}`);
      assertEqual(ok.user!.tenantId, "demo", "joins demo");
      assertEqual((r.first as { tenantId: string }).tenantId, "demo", "the first user is in demo too");
      assertEqual((r.second as { tenantId: string } | null)?.tenantId, "demo", "the second user is stored in demo");
      assert(verifyPassword("second password", (r.second as { passwordHash: string }).passwordHash), "with the scrypt hash of the password");
      assertEqual((r.invite as { email: string }).email, "second@desk.com", "invite email lower-cased");
    });
    test("wrong email, expired, unknown and used invites are refused", () => {
      assertEqual(JSON.stringify(r.wrongEmail), JSON.stringify({ ok: false, reason: "email-mismatch" }), "wrong email");
      assertEqual(JSON.stringify(r.expired), JSON.stringify({ ok: false, reason: "expired" }), "after seven days");
      assertEqual(JSON.stringify(r.bogus), JSON.stringify({ ok: false, reason: "invalid" }), "unknown token");
      assertEqual(JSON.stringify(r.again), JSON.stringify({ ok: false, reason: "used" }), "second use");
      assertEqual(JSON.stringify(r.exists), JSON.stringify({ ok: false, reason: "exists" }), "email already has an account");
    });
    if (row) {
      test("the stored row carries the SHA-256 of the token, not the token, and is marked used", () => {
        assertEqual(row.token_hash, inviteTokenHash(String(r.token)), "hash at rest");
        assert(!Object.values(row).includes(r.token), "the raw token is nowhere in the row");
        assert(row.used_at != null && row.used_by != null, "used_at and used_by set");
      });
    }
  }

  // ---- Who may register ----------------------------------------------------------------------------
  suite("WP-DS05 registration: invite only in production");

  test("production is invite only, by NODE_ENV or VERCEL_ENV, and cannot be opened", () => {
    assertEqual(registrationMode(PROD), "invite", "NODE_ENV production");
    assertEqual(registrationMode(env({ VERCEL_ENV: "production" })), "invite", "VERCEL_ENV production");
    assertEqual(registrationMode({ NODE_ENV: "production", REGISTRATION_MODE: "open" } as NodeJS.ProcessEnv), "invite", "open is ignored in production");
    assertEqual(registrationMode(DEV), "open", "dev stays open as before");
    assertEqual(registrationMode(env({ VERCEL_ENV: "preview", REGISTRATION_MODE: "invite" })), "invite", "a preview can opt in");
  });

  test("an uninvited email gets a polite 403 in production, even if it has an account", async () => {
    const store = new InMemoryAuthStore();
    await store.createUser("taken@desk.com", hashPassword("whatever pw"), "t1");
    const fresh = await registerUser({ email: "new@desk.com", password: "long enough pw" }, store, PROD);
    const taken = await registerUser({ email: "taken@desk.com", password: "long enough pw" }, store, PROD);
    assert(!fresh.ok && fresh.status === 403 && fresh.code === "invite_required", JSON.stringify(fresh));
    assert(!fresh.ok && fresh.error === INVITE_REQUIRED_MESSAGE, "the polite message");
    assert(/invitation only/.test(INVITE_REQUIRED_MESSAGE) && /please/i.test(INVITE_REQUIRED_MESSAGE), "it is polite and says why");
    assert(!taken.ok && taken.status === 403, "no 409, so an uninvited caller cannot probe for accounts");
    assertEqual(await store.findUserByEmail("new@desk.com"), null, "nothing was created");
  });

  test("a valid invite registers into the invite's tenant; a bad one gets the polite 403", async () => {
    const store = new InMemoryAuthStore();
    const t = await store.createTenant("Acme Credit");
    const { token } = await store.createInvite(t.id, "pm@acme.com", new Date(Date.now() + 7 * DAY));
    const bad = await registerUser({ email: "pm@acme.com", password: "long enough pw", invite: "forged" }, store, PROD);
    const good = await registerUser({ email: "pm@acme.com", password: "long enough pw", invite: token }, store, PROD);
    assert(!bad.ok && bad.status === 403 && bad.error === INVITE_INVALID_MESSAGE, JSON.stringify(bad));
    assert(good.ok && good.user.tenantId === "acme-credit", JSON.stringify(good));
  });

  test("outside production an uninvited registration still gets a fresh tenant", async () => {
    const store = new InMemoryAuthStore();
    const r = await registerUser({ email: "dev@desk.com", password: "long enough pw" }, store, DEV);
    assert(r.ok && r.user.tenantId.length > 0, JSON.stringify(r));
  });

  test("the register route answers an uninvited production caller 403 with the message", async () => {
    resetRateLimiterForTests();
    resetAuthStoreForTests();
    const res = await withEnv({ VERCEL_ENV: "production", REGISTRATION_MODE: undefined }, () =>
      register(post("http://x/api/auth/register", { email: "walk-in@desk.com", password: "long enough pw" })),
    );
    const body = (await res.json()) as { error?: string; code?: string };
    assertEqual(res.status, 403, "403");
    assertEqual(body.error, INVITE_REQUIRED_MESSAGE, "polite refusal");
    assertEqual(body.code, "invite_required", "a code the login page can key on");
    assertEqual(await getAuthStore().findUserByEmail("walk-in@desk.com"), null, "no account made");
    resetAuthStoreForTests();
    resetRateLimiterForTests();
  });

  // ---- The failed-login gate --------------------------------------------------------------------------
  suite("WP-DS05 login: the eleventh bad login in a minute is 429 with Retry-After");

  test("the login route: ten 401s, then 429 with Retry-After, even with the right password", async () => {
    resetRateLimiterForTests();
    resetAuthStoreForTests();
    await getAuthStore().createUser("victim@desk.com", hashPassword("the real password"), "t-victim");
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      statuses.push((await login(post("http://x/api/auth/login", { email: "victim@desk.com", password: `guess ${i}` }))).status);
    }
    const eleventh = await login(post("http://x/api/auth/login", { email: "victim@desk.com", password: "guess 10" }));
    const rightPw = await login(post("http://x/api/auth/login", { email: "victim@desk.com", password: "the real password" }));
    resetRateLimiterForTests();
    resetAuthStoreForTests();
    assertEqual(statuses.join(","), Array(10).fill(401).join(","), "the first ten are plain 401s");
    assertEqual(eleventh.status, 429, "the eleventh is 429");
    const retry = Number(eleventh.headers.get("retry-after"));
    assert(retry >= 1 && retry <= LOGIN_FAILURES.windowSeconds, `Retry-After ${retry} is within the minute`);
    assertEqual(rightPw.status, 429, "the right password does not get through while blocked");
  });

  test("the gate counts failures only, per email and address, and clears after the window", async () => {
    const limiter = new InMemoryRateLimiter();
    const email = "someone@desk.com";
    for (let i = 0; i < 9; i++) await recordLoginFailure(limiter, email, "1.1.1.1");
    const afterNine = await loginBlockedFor(limiter, email, "1.1.1.1");
    for (let i = 0; i < 5; i++) await loginBlockedFor(limiter, email, "1.1.1.1"); // looking does not count
    const stillNine = (await limiter.peek(loginFailureKey(email, "1.1.1.1"))).count;
    const tenth = await recordLoginFailure(limiter, email, "1.1.1.1");
    const afterTen = await loginBlockedFor(limiter, email, "1.1.1.1");
    const otherIp = await loginBlockedFor(limiter, email, "2.2.2.2");
    const otherEmail = await loginBlockedFor(limiter, "other@desk.com", "1.1.1.1");
    assertEqual(afterNine, null, "nine failures: not blocked");
    assertEqual(stillNine, 9, "peek does not add to the count");
    assertEqual(tenth, null, "the tenth failure is itself a 401");
    assert(afterTen !== null && afterTen <= 60, `blocked for ${afterTen}s after ten`);
    assertEqual(otherIp, null, "another address is not blocked by this gate");
    assertEqual(otherEmail, null, "another email is not blocked by this gate");
    // The window is a minute: make the clock jump past it.
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
      assertEqual(await loginBlockedFor(limiter, email, "1.1.1.1"), null, "clear after a minute");
    } finally {
      Date.now = realNow;
    }
  });

  test("the shared limiter used by the route has peek", () => {
    resetRateLimiterForTests();
    assertEqual(typeof getRateLimiter().peek, "function", "peek on the factory's limiter");
  });

  // ---- The add-user script ----------------------------------------------------------------------------------
  suite("WP-DS05 add-user: a second user joins a named tenant, and nothing is sent");

  test("add-user invites a second user to demo; the link registers them into demo", async () => {
    const store = new InMemoryAuthStore();
    await store.createTenant("demo");
    await store.createUser("cam@desk.com", hashPassword("first user pw"), "demo");
    const lines: string[] = [];
    const { value: code, calls } = await noNetwork(() =>
      runAddUser(["--tenant", "demo", "--email", "Analyst@Desk.com", "--send", "--app-url", "https://app.example"], store, (l) => lines.push(l), {} as NodeJS.ProcessEnv, NOW),
    );
    const out = lines.join("\n");
    assertEqual(code, 0, out);
    assertEqual(calls, 0, "no network call at all");
    assert(out.includes("nothing was sent"), "it says nothing was sent");
    assert(out.includes("To: analyst@desk.com"), "the email is addressed to the invitee");
    assert(out.includes("You have been invited to join the demo desk on Tearline."), "the template body");
    assert(out.includes(`Expires: ${new Date(NOW.getTime() + 7 * DAY).toISOString()}`), "seven days");
    const token = tokenFrom(lines);
    assert(token.length >= 40 && out.includes("https://app.example/login?invite="), "a real token in the link");
    const r = await registerUser({ email: "analyst@desk.com", password: "long enough pw", invite: token }, store, PROD, NOW);
    assert(r.ok && r.user.tenantId === "demo", JSON.stringify(r));
    assertEqual((await store.findUserByEmail("cam@desk.com"))?.tenantId, "demo", "the first user is still in demo");
  });

  test("a dry run writes nothing and sends nothing", async () => {
    const store = new InMemoryAuthStore();
    await store.createTenant("demo");
    const lines: string[] = [];
    const { value: code, calls } = await noNetwork(() =>
      runAddUser(["--tenant", "demo", "--email", "dry@desk.com", "--dry-run", "--send"], store, (l) => lines.push(l), {} as NodeJS.ProcessEnv, NOW),
    );
    const out = lines.join("\n");
    assertEqual(code, 0, out);
    assertEqual(calls, 0, "no network call");
    assert(out.startsWith("DRY RUN. Nothing was written and nothing was sent."), "says so first");
    assert(out.includes("Subject: Your invitation to demo on Tearline"), "the template is rendered");
    const r = await registerUser({ email: "dry@desk.com", password: "long enough pw", invite: tokenFrom(lines) }, store, PROD, NOW);
    assert(!r.ok && r.status === 403, "the placeholder link registers nobody");

    const created: string[] = [];
    await runAddUser(["--tenant", "Fresh Desk", "--email", "x@y.com", "--dry-run", "--create-tenant"], store, (l) => created.push(l), {} as NodeJS.ProcessEnv, NOW);
    assert(created.join("\n").includes('Would create tenant "Fresh Desk" (id fresh-desk)'), created.join(" | "));
    assertEqual(await store.findTenant("Fresh Desk"), null, "the tenant was not made");
  });

  test("an unknown tenant, an existing account and bad arguments are refused", async () => {
    const store = new InMemoryAuthStore();
    await store.createTenant("demo");
    await store.createUser("cam@desk.com", hashPassword("first user pw"), "demo");
    const a: string[] = [];
    const b: string[] = [];
    const c: string[] = [];
    const unknown = await runAddUser(["--tenant", "nope", "--email", "x@desk.com"], store, (l) => a.push(l), {} as NodeJS.ProcessEnv);
    const existing = await runAddUser(["--tenant", "demo", "--email", "cam@desk.com"], store, (l) => b.push(l), {} as NodeJS.ProcessEnv);
    const bad = await runAddUser(["--email"], store, (l) => c.push(l), {} as NodeJS.ProcessEnv);
    assertEqual(unknown, 1, "unknown tenant exits 1");
    assert(a.join(" ").includes('No tenant is named "nope"'), a.join(" | "));
    assertEqual(existing, 1, "existing account exits 1");
    assert(b.join(" ").includes("already has an account"), b.join(" | "));
    assertEqual(bad, 2, "bad arguments exit 2");
  });

  test("argument parsing and the template", () => {
    const p = parseAddUserArgs(["--tenant", "demo", "--email", "a@b.com"], env({ APP_URL: "https://app.tearline.test" }));
    assertEqual(p.errors.length, 0, p.errors.join(","));
    assertEqual(p.appUrl, "https://app.tearline.test", "APP_URL is the default base");
    assert(!p.send && !p.dryRun, "both flags off by default");
    const mail = renderInviteEmail({ email: "a@b.com", tenantName: "demo", link: "https://x/login?invite=t", expiresAt: new Date("2026-10-04T09:00:00Z") });
    assert(mail.text.includes("It expires on Sun 4 Oct 2026, 09:00 UTC."), mail.text);
    assert(!mail.text.includes("—"), "no em-dashes in the template");
  });

  test("addUser refuses a malformed email before touching the store", async () => {
    let msg = "";
    try {
      await addUser(new InMemoryAuthStore(), { tenant: "demo", email: "not-an-email" });
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(msg.includes("is not an email address"), msg);
  });
}
