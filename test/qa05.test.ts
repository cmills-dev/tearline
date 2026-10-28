// test/qa05.test.ts
// WP-QA05 part 1: tenant identity and the shared-learning privacy count. Each case was a failing
// test before its fix, and the finding it proves is named in the suite line and written up in
// docs/programme/reports/WP-QA05-part1.md. No network and no model: the monitor's snapshot
// builder is injected, and the middleware is called with a hand-built request.

import { suite, test, assert, assertEqual } from "./harness";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { NextRequest } from "next/server";
import { middleware } from "../middleware";
import {
  ANON_PREFIX,
  isAnonymousTenant,
  mintTenantCookie,
  resolveTenantId,
  tenantCookieSecret,
  verifyTenantCookie,
} from "../lib/auth/tenantCookie";
import { InMemorySharedLearningStore } from "../lib/clientspec/sharedStore";
import { countsTowardK, decideCandidates, DEFAULT_K } from "../lib/clientspec/promote";
import { InMemoryMonitorStore } from "../lib/monitor/store";
import { runCheckOne } from "../lib/monitor/runCheck";
import type { ChangeEvent, Snapshot } from "../lib/monitor/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const SECRET = "qa05-test-secret-long-enough-to-pass";
const REGISTERED = "3f1c2a9e-4b7d-4e21-9a55-0c6f1d2e8b40"; // the shape register gives a tenant

function snapshot(takenAt: string, charges: { id: string; status: string }[]): Snapshot {
  return {
    tenantId: "t-mon",
    chNumber: "00000042",
    takenAt,
    companyStatus: "active",
    charges,
    pscIds: [],
    officerIds: [],
    accountsOverdue: false,
    confirmationOverdue: false,
  };
}

export async function registerQa05Tests(): Promise<void> {
  // -------------------------------------------------------------------------------------------
  // D3. Without AUTH_REQUIRED, lib/tenant.ts returned the raw `tid` cookie and the middleware
  // kept any existing value, so `Cookie: tid=<a registered tenant id>` opened that workspace.
  // The cookie is now `<tenant>.<hmac>`, anonymous tenants carry the `anon_` prefix, and the
  // parsing lives in a pure function so it can be tested here.
  // -------------------------------------------------------------------------------------------
  const minted = await mintTenantCookie(SECRET);
  const roundTrip = await verifyTenantCookie(minted.value, SECRET);
  const bareRegistered = await verifyTenantCookie(REGISTERED, SECRET);
  const prefixedUnsigned = await verifyTenantCookie(`${ANON_PREFIX}${REGISTERED}`, SECRET);
  const otherSecret = await verifyTenantCookie(minted.value, "some-other-secret-entirely-xx");
  const sig = minted.value.slice(minted.value.lastIndexOf(".") + 1);
  const swapped = await verifyTenantCookie(`${ANON_PREFIX}${REGISTERED}.${sig}`, SECRET);
  // A registered id with a valid signature over it still is not accepted: only anon_ ids are
  // ever carried in `tid`, so a leaked signing key cannot turn the cookie into a session.
  const signedRegistered = await verifyTenantCookie(
    `${REGISTERED}.${minted.value.slice(minted.value.lastIndexOf(".") + 1)}`,
    SECRET,
  );

  suite("QA05 D3 / the tid cookie is signed and anonymous ids are prefixed");
  test("a minted cookie verifies to an anon_ tenant", () => {
    assert(minted.tenantId.startsWith(ANON_PREFIX), `tenant ${minted.tenantId}`);
    assertEqual(roundTrip, minted.tenantId, "round trip");
    assert(isAnonymousTenant(minted.tenantId), "the minted tenant is anonymous");
  });
  test("a bare registered tenant id in tid is rejected", () => {
    assertEqual(bareRegistered, null, "unsigned registered id");
    assertEqual(signedRegistered, null, "registered id with a borrowed signature");
    assert(!isAnonymousTenant(REGISTERED), "a registered id is not anonymous");
  });
  test("an unsigned, re-signed or re-keyed cookie is rejected", () => {
    assertEqual(prefixedUnsigned, null, "prefix without signature");
    assertEqual(swapped, null, "another tenant under a borrowed signature");
    assertEqual(otherSecret, null, "signed with another secret");
  });

  const viaForged = await resolveTenantId({ session: null, authRequired: false, tidCookie: REGISTERED, secret: SECRET });
  const viaValid = await resolveTenantId({ session: null, authRequired: false, tidCookie: minted.value, secret: SECRET });
  const viaNone = await resolveTenantId({ session: null, authRequired: false, tidCookie: undefined, secret: SECRET });
  const viaSession = await resolveTenantId({
    session: { tenantId: REGISTERED },
    authRequired: false,
    tidCookie: minted.value,
    secret: SECRET,
  });
  const enforcedAnon = await resolveTenantId({ session: null, authRequired: true, tidCookie: minted.value, secret: SECRET });
  const enforcedSession = await resolveTenantId({ session: { tenantId: REGISTERED }, authRequired: true, tidCookie: undefined });

  test("resolveTenantId never returns a forged tid as the tenant", () => {
    assertEqual(viaForged, "", "a forged tid resolves to no tenant");
    assertEqual(viaNone, "", "no tid resolves to no tenant, not a shared 'anon' bucket");
    assertEqual(viaValid, minted.tenantId, "a valid tid resolves to its anon tenant");
    assertEqual(viaSession, REGISTERED, "a verified session always wins");
  });
  test("with AUTH_REQUIRED=1 behaviour is unchanged: session or nothing", () => {
    assertEqual(enforcedAnon, "", "no anonymous access in enforced mode");
    assertEqual(enforcedSession, REGISTERED, "session tenant");
  });

  // The middleware replaces a forged or unsigned tid with a freshly minted one, for this request
  // and the browser. Called with the dev secret, as the local demo runs.
  const savedAuthRequired = process.env.AUTH_REQUIRED;
  delete process.env.AUTH_REQUIRED;
  const forgedReq = new NextRequest("http://x/workspace", { headers: { cookie: `tid=${REGISTERED}` } });
  const forgedRes = await middleware(forgedReq);
  const setValue = forgedRes.cookies.get("tid")?.value ?? "";
  const setTenant = await verifyTenantCookie(setValue, tenantCookieSecret());
  const reqValue = forgedReq.cookies.get("tid")?.value ?? "";
  const goodReq = new NextRequest("http://x/workspace", { headers: { cookie: `tid=${setValue}` } });
  const goodRes = await middleware(goodReq);
  process.env.AUTH_REQUIRED = "1";
  const enforcedRes = await middleware(new NextRequest("http://x/workspace"));
  if (savedAuthRequired === undefined) delete process.env.AUTH_REQUIRED;
  else process.env.AUTH_REQUIRED = savedAuthRequired;

  test("the middleware replaces a forged tid with a new signed anonymous one", () => {
    assert(setValue && setValue !== REGISTERED, `set-cookie tid=${setValue}`);
    assert(setTenant !== null && setTenant.startsWith(ANON_PREFIX), `verifies to ${setTenant}`);
    assertEqual(reqValue, setValue, "this request's server components see the new value");
  });
  test("the middleware keeps a valid signed tid", () => {
    assertEqual(goodRes.cookies.get("tid"), undefined, "no new cookie for a valid one");
  });
  test("with AUTH_REQUIRED=1 the middleware mints nothing (no anonymous tenant exists)", () => {
    assertEqual(enforcedRes.cookies.get("tid"), undefined, "no tid in enforced mode");
  });

  const tenantSrc = readFileSync(join(HERE, "..", "lib", "tenant.ts"), "utf8");
  test("lib/tenant.ts goes through resolveTenantId, not the raw cookie", () => {
    assert(/resolveTenantId\(/.test(tenantSrc), "getTenantId calls resolveTenantId");
    assert(!/\?\?\s*"anon"/.test(tenantSrc), "no raw cookie fallback");
  });

  // -------------------------------------------------------------------------------------------
  // Shared-learning k-anonymity counted tenant-id strings, so one actor with three free anonymous
  // ids met k=3 alone. The rule now: only a verified identity (a tenant bound to a signed-in
  // session) counts toward k. Anonymous tenants contribute nothing to the shared plane.
  // -------------------------------------------------------------------------------------------
  const shared = new InMemorySharedLearningStore();
  for (let i = 0; i < 3; i++) {
    const anon = await mintTenantCookie(SECRET);
    await shared.contribute("sock puppet margin", "ebitda", anon.tenantId);
  }
  await shared.contribute("sock puppet margin", "ebitda", "anon"); // the old shared fallback id
  await shared.contribute("sock puppet margin", "ebitda", "");
  for (const t of ["desk-1", "desk-2", "desk-3"]) await shared.contribute("recurring ebitda", "ebitda", t);
  const cands = await shared.listCandidates();
  const puppet = cands.find((c) => c.labelNorm === "sock puppet margin");
  const real = cands.find((c) => c.labelNorm === "recurring ebitda");
  const decisions = decideCandidates(cands);

  suite("QA05 k-anonymity / only verified identities count toward k");
  test("three anonymous tenants do not reach k", () => {
    assert(!puppet || puppet.distinctTenants === 0, `anonymous count ${puppet?.distinctTenants}`);
    assert(!decisions.some((d) => d.entry.labelNorm === "sock puppet margin" && d.promote), "not promoted");
  });
  test("three registered tenants still reach k", () => {
    assertEqual(real?.distinctTenants, DEFAULT_K, "registered desks count");
  });
  test("countsTowardK names the rule", () => {
    assert(countsTowardK(REGISTERED), "registered counts");
    assert(!countsTowardK(`${ANON_PREFIX}x`), "anon_ does not");
    assert(!countsTowardK("anon"), "legacy anon does not");
    assert(!countsTowardK(""), "empty does not");
  });
  const feedbackSrc = readFileSync(join(HERE, "..", "app", "api", "onboarding", "feedback", "route.ts"), "utf8");
  const pgSharedSrc = readFileSync(join(HERE, "..", "lib", "clientspec", "sharedPostgres.ts"), "utf8");
  test("the feedback route contributes only under a verified session, and Postgres applies the rule", () => {
    assert(/getSession\(\)/.test(feedbackSrc), "feedback route reads the verified session");
    assert(/countsTowardK\(tenantId\)/.test(pgSharedSrc), "Postgres store applies the rule");
  });

  // -------------------------------------------------------------------------------------------
  // Two concurrent monitor checks on one company (cron and manual) both diffed against the same
  // stored snapshot and recorded every event twice. Events now carry a key derived from the
  // baseline they were diffed against, and the store records a key once.
  // -------------------------------------------------------------------------------------------
  const mon = new InMemoryMonitorStore();
  await mon.addToWatchlist("t-mon", "00000042");
  await mon.saveSnapshot(snapshot("2026-09-24T08:00:00.000Z", [{ id: "1", status: "outstanding" }]));
  const moved = [{ id: "1", status: "outstanding" }, { id: "2", status: "outstanding" }];
  const buildA = async () => snapshot("2026-09-24T09:00:00.000Z", moved);
  const buildB = async () => snapshot("2026-09-24T09:00:01.000Z", moved);
  const [ra, rb] = await Promise.all([
    runCheckOne("t-mon", "00000042", mon, buildA),
    runCheckOne("t-mon", "00000042", mon, buildB),
  ]);
  const stored = await mon.listEvents("t-mon");

  // The store on its own: the same keyed event recorded twice is stored once, while two events
  // without a key (older callers) are both kept.
  const direct = new InMemoryMonitorStore();
  const ev: ChangeEvent = {
    tenantId: "t-d",
    chNumber: "1",
    kind: "charge-registered",
    detail: "New charge 2 registered (status outstanding).",
    provenance: { source: "s", field: "charges", retrievedAt: "2026-09-24T09:00:00.000Z", locator: "l" },
    observedAt: "2026-09-24T09:00:00.000Z",
    key: "k1",
  };
  await direct.recordEvents([ev]);
  await direct.recordEvents([{ ...ev, observedAt: "2026-09-24T09:00:01.000Z" }]);
  await direct.recordEvents([{ ...ev, tenantId: "t-other" }]);
  const directCount = (await direct.listEvents("t-d")).length;
  const otherCount = (await direct.listEvents("t-other")).length;

  const pgMonSrc = readFileSync(join(HERE, "..", "lib", "monitor", "postgres.ts"), "utf8");
  const migrationPath = join(HERE, "..", "db", "migrations", "0012_change_event_key.sql");
  const migration = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";

  suite("QA05 monitor / concurrent checks record each event once");
  test("two concurrent checks of one company store the new charge once", () => {
    assert(ra.ok && rb.ok, `${ra.error ?? ""} ${rb.error ?? ""}`);
    assertEqual(stored.length, 1, `stored ${stored.map((e) => e.kind).join(", ")}`);
  });
  test("the store records a keyed event once per tenant", () => {
    assertEqual(directCount, 1, "same key, same tenant");
    assertEqual(otherCount, 1, "the key is scoped to its tenant");
  });
  test("Postgres dedupes on (tenant_id, event_key)", () => {
    assert(/event_key/.test(pgMonSrc) && /on conflict \(tenant_id, event_key\) do nothing/.test(pgMonSrc), "insert is idempotent");
    assert(/create unique index if not exists \w+ on change_event \(tenant_id, event_key\)/.test(migration), "unique index");
  });
}
