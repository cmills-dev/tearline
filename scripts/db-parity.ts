// scripts/db-parity.ts
// The DB PARITY HARNESS. Every one of the 423 unit tests runs against the in-memory stores;
// the Postgres adapters (lib/store/postgres.ts, lib/monitor/postgres.ts, lib/store/
// shortlistPostgres.ts, lib/clientspec/postgres.ts, lib/clientspec/sharedPostgres.ts,
// lib/kb/kbPostgres.ts) and the SQL in db/migrations/*.sql have NEVER actually run. This script
// exercises the durable path so it can be trusted before a deploy.
//
// Two modes, chosen by whether a Postgres connection string is configured:
//
//   MODE A (real Postgres): databaseUrl() returns a URL. Connect with postgres.js, APPLY every
//   db/migrations/*.sql in filename order, then run a per-store SMOKE check through the REAL
//   factories (getStore()/getMonitorStore()/... return the Postgres adapters when DATABASE_URL
//   is set): persist a record for tenant "parity-a", read it back, and assert tenant "parity-b"
//   cannot see it (tenant isolation), plus the two GLOBAL stores' (shared-learning, kb) basic
//   round-trip. PASS/FAIL per store; the process exits non-zero on any failure. This is the
//   authoritative check: it runs the real SQL against a real Postgres with real RLS.
//
//   MODE B (no Postgres): no DATABASE_URL. BEST-EFFORT local emulation with pg-mem. pg-mem is
//   NOT PostgreSQL: it does NOT enforce row-level security and lacks features (some jsonb ops,
//   identity columns, plpgsql, policies), so a pg-mem PASS does NOT prove the MNPI wall or full
//   SQL compatibility - it only catches gross schema / adapter SQL errors. If pg-mem cannot load
//   the schema (which is expected: the migrations enable RLS and create policies pg-mem cannot
//   model), the harness reports EXACTLY which migration and statement it choked on (useful
//   signal) and EXITS 0 with a clear "run against a real Postgres via DATABASE_URL for a true
//   check" message. pg-mem limitations are NEVER reported as real bugs.
//
// Run it:
//   MODE B (no setup):        npm run db:parity
//   MODE A (true check):      DATABASE_URL=postgres://user:pass@host:5432/db npm run db:parity
//                             (MODE A needs the `postgres` package installed: npm install postgres)

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { databaseUrl } from "../lib/store/postgres";
import { getStore } from "../lib/store/tearSheetStore";
import { getMonitorStore } from "../lib/monitor/store";
import { getShortlistStore } from "../lib/store/shortlistStore";
import { getClientSpecStore } from "../lib/clientspec/store";
import { getSharedLearningStore } from "../lib/clientspec/sharedStore";
import { getKbStore } from "../lib/kb/kbStore";
import { getRunStore } from "../lib/run/store";
import { emptyStages, type RunRecord } from "../lib/run/types";
import { manifestForKey } from "../lib/engine/pipeline";
import type { OriginationSuggestion } from "../lib/originate/suggestion";
import type { Snapshot, ChangeEvent } from "../lib/monitor/types";
import type { ClientSpec } from "../lib/clientspec/types";
import type { KbFactRecord } from "../lib/kb/kbTypes";

// --------------------------------------------------------------------------------------------
// Logging. Plain, prefixed, so the mode, the store and the pass/fail are unmistakable in a CI log.
// --------------------------------------------------------------------------------------------
const line = (s = "") => console.log(s);
const info = (s: string) => console.log(`  ${s}`);
const banner = (s: string) => {
  const bar = "=".repeat(Math.max(60, s.length + 4));
  line(bar);
  line(s);
  line(bar);
};

// A tiny assertion; a failed smoke step throws with a readable message the runner catches.
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

// A fresh tag per run, so a second run against a database that keeps its data (the local preview,
// a long-lived Neon branch) starts from clean tenants and a clean shared-learning label, rather
// than counting the last run's rows. app_user cannot delete, so cleaning up is not an option.
const RUN_TAG = Date.now().toString(36);
const TENANT_A = `parity-a-${RUN_TAG}`;
const TENANT_B = `parity-b-${RUN_TAG}`;

// --------------------------------------------------------------------------------------------
// The smoke checks, one per durable store. Each PERSISTS a small record for tenant "parity-a",
// reads it back, and (for the tenant-scoped stores) asserts tenant "parity-b" cannot see it.
// The two GLOBAL stores (shared-learning, kb) are cross-tenant by design, so they only assert a
// basic round-trip, exactly like their in-memory tests. Each throws on the first failure.
// --------------------------------------------------------------------------------------------

async function smokeTearSheet(): Promise<void> {
  const store = getStore();
  const manifest = manifestForKey("meridian");
  assert(manifest, "manifestForKey('meridian') returned null (fixture missing)");
  const key = "parity-tearsheet";

  await store.save(TENANT_A, key, manifest!);
  const loaded = await store.load(TENANT_A, key);
  assert(loaded !== null, "saved manifest did not read back for parity-a");
  assert(
    loaded!.entity.companyName === manifest!.entity.companyName,
    "read-back manifest entity does not match the saved one",
  );
  const listedA = await store.list(TENANT_A);
  assert(listedA.some((r) => r.key === key), "saved tear sheet is not in parity-a's list");

  // Tenant isolation: parity-b must not see parity-a's record.
  const loadedB = await store.load(TENANT_B, key);
  assert(loadedB === null, "ISOLATION BREACH: parity-b could load parity-a's tear sheet");
  const listedB = await store.list(TENANT_B);
  assert(
    !listedB.some((r) => r.key === key),
    "ISOLATION BREACH: parity-a's tear sheet appears in parity-b's list",
  );
}

async function smokeMonitor(): Promise<void> {
  const store = getMonitorStore();
  const ch = "SC123456";

  await store.addToWatchlist(TENANT_A, ch);
  const wl = await store.listWatchlist(TENANT_A);
  assert(wl.some((w) => w.chNumber === ch), "watchlist entry did not read back for parity-a");

  const snapshot: Snapshot = {
    tenantId: TENANT_A,
    chNumber: ch,
    takenAt: "2026-08-19T09:00:00.000Z",
    companyStatus: "active",
    charges: [{ id: "1", status: "outstanding" }],
    pscIds: ["psc-1"],
    officerIds: ["off-1"],
    accountsOverdue: false,
    confirmationOverdue: false,
  };
  await store.saveSnapshot(snapshot);
  const loadedSnap = await store.loadSnapshot(TENANT_A, ch);
  assert(loadedSnap !== null, "snapshot did not read back for parity-a");
  assert(loadedSnap!.companyStatus === "active", "read-back snapshot does not match the saved one");

  const event: ChangeEvent = {
    tenantId: TENANT_A,
    chNumber: ch,
    kind: "charge-registered",
    detail: "A new charge was registered.",
    provenance: {
      source: "Companies House",
      field: "charges",
      retrievedAt: "2026-08-19T09:00:00.000Z",
      locator: "https://example.invalid/company/SC123456",
    },
    observedAt: "2026-08-19T09:00:00.000Z",
  };
  await store.recordEvents([event]);
  const events = await store.listEvents(TENANT_A);
  assert(events.length >= 1, "recorded change event did not read back for parity-a");

  // Tenant isolation across all three record kinds.
  assert(
    (await store.listWatchlist(TENANT_B)).length === 0,
    "ISOLATION BREACH: parity-b sees parity-a's watchlist",
  );
  assert(
    (await store.loadSnapshot(TENANT_B, ch)) === null,
    "ISOLATION BREACH: parity-b could load parity-a's snapshot",
  );
  assert(
    (await store.listEvents(TENANT_B)).length === 0,
    "ISOLATION BREACH: parity-b sees parity-a's change events",
  );
}

async function smokeShortlist(): Promise<void> {
  const store = getShortlistStore();
  const suggestion: OriginationSuggestion = {
    target: { nodeId: "co:PARITY01", name: "PARITY TARGET LTD", chNumber: "PARITY01" },
    tier: "cold",
    whyNow: [],
    fit: [],
    warmPath: null,
    score: { total: 0.42, catalyst: 0.6, fit: 1, pathGate: 0.7 },
    abstentions: [],
  };

  const saved = await store.save(TENANT_A, suggestion);
  assert(typeof saved.savedAt === "string" && saved.savedAt.length > 0, "saved suggestion has no savedAt");
  const listedA = await store.list(TENANT_A);
  assert(
    listedA.some((s) => s.target.chNumber === "PARITY01"),
    "saved suggestion did not read back for parity-a",
  );

  // Tenant isolation.
  const listedB = await store.list(TENANT_B);
  assert(
    !listedB.some((s) => s.target.chNumber === "PARITY01"),
    "ISOLATION BREACH: parity-b sees parity-a's shortlist",
  );
}

async function smokeClientSpec(): Promise<void> {
  const store = getClientSpecStore();
  const spec: ClientSpec = {
    contractVersion: "0",
    clientId: TENANT_A,
    version: 0,
    name: "Parity house sheet",
    fields: [
      { key: "ebitda", label: "Adjusted EBITDA", ontologyConcept: "concept:ebitda", required: true },
    ],
    styleTokens: {
      voice: "analyst-understated",
      numberStyle: "tabular",
      dateFormat: "D MMM YYYY",
      currencyDefault: "GBP",
    },
    skeleton: ["Header", "Financials"],
    inducedFrom: ["Parity house sheet"],
    createdAt: "2026-08-19T09:00:00.000Z",
  };

  const version = await store.saveSpec(TENANT_A, spec);
  assert(version === 1, `first saveSpec should assign version 1, got ${version}`);
  const specs = await store.listSpecs(TENANT_A);
  assert(specs.length === 1, "saved spec did not read back for parity-a");

  await store.setActiveSpec(TENANT_A, 1);
  const active = await store.getActiveSpec(TENANT_A);
  assert(active !== null && active.version === 1, "active spec pointer did not round-trip");

  const fresh = await store.getState(TENANT_A);
  await store.setState(TENANT_A, { ...fresh, firmName: "Parity Capital" });
  const state = await store.getState(TENANT_A);
  assert(state.firmName === "Parity Capital", "onboarding state did not persist for parity-a");

  // Tenant isolation across specs and state.
  assert(
    (await store.listSpecs(TENANT_B)).length === 0,
    "ISOLATION BREACH: parity-b sees parity-a's specs",
  );
  assert(
    (await store.getActiveSpec(TENANT_B)) === null,
    "ISOLATION BREACH: parity-b sees parity-a's active spec",
  );
  assert(
    (await store.getState(TENANT_B)).firmName === undefined,
    "ISOLATION BREACH: parity-b sees parity-a's onboarding state",
  );
}

async function smokeSharedLearning(): Promise<void> {
  // GLOBAL plane (de-identified, cross-tenant by design): no tenant isolation to assert, only a
  // basic round-trip, mirroring the in-memory test.
  const store = getSharedLearningStore();
  const labelNorm = `adjusted ebitda parity ${RUN_TAG}`;
  const conceptKey = "concept:ebitda";

  // Two DISTINCT tenants confirming the same mapping should count as two contributors.
  await store.contribute(labelNorm, conceptKey, TENANT_A);
  await store.contribute(labelNorm, conceptKey, TENANT_B);
  const candidates = await store.listCandidates();
  const cand = candidates.find((c) => c.labelNorm === labelNorm && c.conceptKey === conceptKey);
  assert(cand !== undefined, "contributed candidate did not read back");
  assert(cand!.distinctTenants === 2, `expected 2 distinct contributors, got ${cand!.distinctTenants}`);

  const version = await store.promote([{ labelNorm, conceptKey }], "parity-harness");
  assert(version >= 1, "promote did not return a version");
  assert((await store.activeVersion()) === version, "activeVersion does not match the promoted version");
  const entries = await store.activeEntries();
  assert(
    entries.some((e) => e.labelNorm === labelNorm && e.conceptKey === conceptKey),
    "promoted entry is not in the active dictionary",
  );
}

async function smokeKb(): Promise<void> {
  // GLOBAL Tier-0 plane (public facts, shared across tenants): no tenant isolation, only a
  // round-trip of resolve + fact accumulation + coverage, mirroring the in-memory test.
  const store = getKbStore();
  const lei = "LEI000000000000PARITY";

  const id1 = await store.resolveEntity({ name: "Parity PLC", lei });
  const id2 = await store.resolveEntity({ name: "Parity Public Limited", lei });
  assert(id1 === id2, "the same LEI resolved to two different master ids");

  const entity = await store.getEntity(id1);
  assert(entity !== null, "resolved entity did not read back");

  const fact: KbFactRecord = {
    masterId: id1,
    metric: "revenue",
    period: "FY2024",
    value: 1000,
    kind: "currency",
    unit: "GBP",
    rung: "R1",
    source: "companies-house",
    docId: "companies-house:parity-1",
    asOf: "2025-01-01T00:00:00.000Z",
    entitlement: "public",
    provenance: null,
    superseded: false,
    ingestedAt: "2025-01-01T00:00:00.000Z",
  };
  await store.upsertFact(fact);
  const facts = await store.listFacts(id1);
  assert(facts.some((f) => f.metric === "revenue"), "upserted fact did not read back");

  const coverage = await store.coverage(id1);
  assert(coverage.items.some((i) => i.metric === "revenue"), "coverage does not report the fact");
}

// The run store (WP-BE06, db/migrations/0011_runs.sql). A run holds no figures, but it holds
// which company a desk looked at and when, which is exactly the kind of thing the wall exists
// for, so the isolation assertion matters as much here as on the tear sheet.
async function smokeRun(): Promise<void> {
  const store = getRunStore();
  const run: RunRecord = {
    id: "parity-run-1",
    tenantId: TENANT_A,
    input: "PARITY TARGET LTD",
    status: "running",
    stages: emptyStages(),
    startedAt: "2026-09-16T09:00:00.000Z",
    endedAt: null,
    elapsedMs: 0,
    sheetKey: null,
    companyNumber: "PARITY01",
    companyName: "PARITY TARGET LTD",
    candidates: null,
    abstentions: [],
    reason: null,
  };

  await store.save(run);
  const loaded = await store.load(TENANT_A, run.id);
  assert(loaded !== null, "run did not read back for parity-a");
  assert(loaded!.stages.length === 5, "read-back run lost its stage rows");

  // The runner overwrites the whole record on every stage transition, so an upsert must update.
  await store.save({ ...run, status: "done", sheetKey: "ch-parity01", endedAt: "2026-09-16T09:01:00.000Z" });
  const updated = await store.load(TENANT_A, run.id);
  assert(updated!.status === "done", "re-saving a run did not update it");
  assert(updated!.sheetKey === "ch-parity01", "the sheet key did not persist");
  assert((await store.list(TENANT_A)).length === 1, "the run was inserted twice rather than updated");

  // Tenant isolation.
  assert(
    (await store.load(TENANT_B, run.id)) === null,
    "ISOLATION BREACH: parity-b could load parity-a's run",
  );
  assert(
    (await store.list(TENANT_B)).length === 0,
    "ISOLATION BREACH: parity-b sees parity-a's runs",
  );
}

interface SmokeCheck {
  store: string;
  fn: () => Promise<void>;
}

const SMOKE_CHECKS: SmokeCheck[] = [
  { store: "tear-sheet   (getStore)", fn: smokeTearSheet },
  { store: "monitor      (getMonitorStore)", fn: smokeMonitor },
  { store: "shortlist    (getShortlistStore)", fn: smokeShortlist },
  { store: "client-spec  (getClientSpecStore)", fn: smokeClientSpec },
  { store: "shared-learn (getSharedLearningStore)", fn: smokeSharedLearning },
  { store: "kb           (getKbStore)", fn: smokeKb },
  { store: "run          (getRunStore)", fn: smokeRun },
];

// Run every smoke check, reporting PASS/FAIL per store with the error on failure. Returns the
// number of failures so the caller can set the exit code.
async function runSmokeChecks(): Promise<number> {
  line();
  line("Smoke checks (persist -> read back -> tenant isolation):");
  let failures = 0;
  for (const check of SMOKE_CHECKS) {
    try {
      await check.fn();
      info(`PASS  ${check.store}`);
    } catch (err) {
      failures++;
      const msg = err instanceof Error ? err.message : String(err);
      info(`FAIL  ${check.store}`);
      info(`      -> ${msg}`);
    }
  }
  return failures;
}

// --------------------------------------------------------------------------------------------
// Migration loading. Files are applied in strict filename order (0001, 0002, ...).
// --------------------------------------------------------------------------------------------
function migrationsDir(): string {
  return fileURLToPath(new URL("../db/migrations", import.meta.url));
}

function migrationFiles(): string[] {
  return readdirSync(migrationsDir())
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

// Split a SQL file into top-level statements, respecting dollar-quoted bodies ($$ ... $$ or
// $tag$ ... $tag$, used by the plpgsql function in 0002) and line comments, so a `;` inside a
// function body never splits a statement. Only used in MODE B, to pinpoint which statement pg-mem
// chokes on; MODE A applies each file whole.
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  let dollarTag: string | null = null;

  while (i < sql.length) {
    const two = sql.slice(i, i + 2);

    // Inside a dollar-quoted body: consume until the matching closing tag.
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      current += sql[i++];
      continue;
    }

    // Line comment: consume to end of line (kept in the statement text for context).
    if (two === "--") {
      const nl = sql.indexOf("\n", i);
      const end = nl === -1 ? sql.length : nl + 1;
      current += sql.slice(i, end);
      i = end;
      continue;
    }

    // Opening of a dollar-quote tag: $$ or $tag$.
    if (sql[i] === "$") {
      const match = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (match) {
        dollarTag = match[0];
        current += dollarTag;
        i += dollarTag.length;
        continue;
      }
    }

    if (sql[i] === ";") {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = "";
      i++;
      continue;
    }

    current += sql[i++];
  }

  const tail = current.trim();
  if (tail) statements.push(tail);
  // Drop statements that are only line comments / whitespace (e.g. the commented-out RLS notes at
  // the foot of 0001), so they are never sent to the engine and never mis-reported as a failure.
  return statements.filter((s) => !isCommentOnly(s));
}

// True when a statement has no executable SQL once `--` line comments and whitespace are removed.
function isCommentOnly(stmt: string): boolean {
  const stripped = stmt
    .split("\n")
    .map((l) => {
      const idx = l.indexOf("--");
      return idx === -1 ? l : l.slice(0, idx);
    })
    .join("\n")
    .trim();
  return stripped.length === 0;
}

// --------------------------------------------------------------------------------------------
// MODE A: real Postgres.
// --------------------------------------------------------------------------------------------
async function runModeA(url: string): Promise<void> {
  banner("DB PARITY - MODE A: real Postgres (authoritative)");
  // Mask credentials in the log.
  info(`target: ${url.replace(/\/\/[^@]*@/, "//***:***@")}`);

  // The harness needs postgres.js to apply the migrations (the store adapters need it too). It is
  // an optional peer dependency installed at the flip step, so a clear message beats a stack trace.
  let postgres: (u: string, opts?: unknown) => {
    unsafe: (q: string) => Promise<unknown>;
    end: () => Promise<void>;
  };
  try {
    // @ts-expect-error optional peer dep: `postgres` is installed only at the flip step
    const mod = await import(/* webpackIgnore: true */ "postgres");
    postgres = (mod as { default?: typeof postgres }).default ?? (mod as typeof postgres);
  } catch {
    line();
    line("The `postgres` package is not installed, but DATABASE_URL is set.");
    line("MODE A needs it to apply migrations and to activate the Postgres store adapters.");
    line("Install it and re-run:");
    line("  npm install postgres");
    line("  npm run db:parity");
    process.exit(1);
    return;
  }

  const sql = postgres(url, { max: 3, idle_timeout: 20, prepare: false });
  try {
    line();
    // WP-DS02: when scripts/db-migrate.ts has run (a schema_migrations ledger exists), the schema
    // belongs to the owner and this process is app_user, which cannot run DDL. Skip straight to
    // the smoke checks, which is the point: the stores and the wall as the app will see them.
    const ledger = await sql.unsafe("select to_regclass('public.schema_migrations') as t");
    const migrated = Boolean(ledger[0]?.t);
    if (migrated) {
      const who = await sql.unsafe("select current_user::text as u");
      line(`Schema applied by db-migrate. Running the checks as ${String(who[0]?.u)}.`);
    } else line("Applying migrations (in filename order):");
    for (const file of migrated ? [] : migrationFiles()) {
      const text = readFileSync(`${migrationsDir()}/${file}`, "utf8");
      try {
        // Run the whole file as one query. The migrations are written to be re-runnable
        // (create table if not exists, drop policy if exists, create or replace function).
        await sql.unsafe(text);
        info(`applied  ${file}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // An "already exists" from a non-guarded statement on a re-run is tolerated; anything
        // else is a real migration failure.
        if (/already exists/i.test(msg)) {
          info(`skipped  ${file} (already applied: ${msg})`);
        } else {
          info(`FAILED   ${file}`);
          info(`         -> ${msg}`);
          throw new Error(`migration ${file} failed: ${msg}`);
        }
      }
    }

    const failures = await runSmokeChecks();
    line();
    if (failures === 0) {
      banner("RESULT: PASS - all durable stores round-trip and isolate on real Postgres");
      process.exit(0);
    } else {
      banner(`RESULT: FAIL - ${failures} store(s) failed on real Postgres`);
      process.exit(1);
    }
  } finally {
    await sql.end().catch(() => {});
  }
}

// --------------------------------------------------------------------------------------------
// MODE B: best-effort pg-mem emulation. Its ONLY reliable signal is "does the schema load";
// pg-mem does not enforce RLS, so any smoke "pass" here would NOT prove the tenant wall.
// --------------------------------------------------------------------------------------------
async function runModeB(): Promise<void> {
  banner("DB PARITY - MODE B: pg-mem emulation (NOT authoritative)");
  line();
  line("!! CAVEAT: pg-mem is NOT PostgreSQL. It does NOT enforce row-level security and lacks");
  line("!! some SQL features (policies, some jsonb ops, identity columns, plpgsql). A pg-mem");
  line("!! PASS does NOT prove the MNPI wall or full SQL compatibility - it only catches gross");
  line("!! schema / adapter SQL errors. For a TRUE check, set DATABASE_URL to a real Postgres");
  line("!! and re-run (MODE A).");
  line();

  // Install pg-mem on demand (dev-only, best effort).
  line("Installing pg-mem (dev dependency, best effort)...");
  const { execSync } = await import("node:child_process");
  try {
    execSync("npm install -D pg-mem", { stdio: "inherit" });
  } catch {
    line();
    line("Could not install pg-mem. Skipping emulation.");
    line("pg-mem could not fully emulate; run against a real Postgres via DATABASE_URL for a true check.");
    process.exit(0);
    return;
  }

  let newDb: (opts?: unknown) => {
    public: { none: (q: string) => void };
    adapters: Record<string, unknown>;
  };
  try {
    const mod = await import("pg-mem");
    newDb = (mod as unknown as { newDb: typeof newDb }).newDb;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    line();
    line(`Could not load pg-mem after install (${msg}). Skipping emulation.`);
    line("pg-mem could not fully emulate; run against a real Postgres via DATABASE_URL for a true check.");
    process.exit(0);
    return;
  }

  const db = newDb();
  line();
  line("Loading the schema into pg-mem (applies migrations statement by statement):");

  for (const file of migrationFiles()) {
    const text = readFileSync(`${migrationsDir()}/${file}`, "utf8");
    const statements = splitStatements(text);
    for (let n = 0; n < statements.length; n++) {
      const stmt = statements[n];
      try {
        db.public.none(stmt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const excerpt = stmt.replace(/\s+/g, " ").slice(0, 160);
        line();
        info(`pg-mem could not load ${file}, statement ${n + 1}:`);
        info(`   ${excerpt}${stmt.length > 160 ? " ..." : ""}`);
        info(`   error: ${msg}`);
        line();
        line("This is a pg-mem emulation limitation, NOT necessarily a real bug: the migrations");
        line("enable row-level security and create policies (and a plpgsql trigger) that pg-mem");
        line("cannot model. It does NOT mean the SQL is wrong on real Postgres.");
        line();
        line("pg-mem could not fully emulate; run against a real Postgres via DATABASE_URL for a true check.");
        process.exit(0);
        return;
      }
    }
    info(`loaded   ${file}`);
  }

  // If we get here pg-mem loaded the ENTIRE schema (unlikely, given RLS). Even so, the adapter
  // smoke checks need postgres.js pointed at a live endpoint, and pg-mem does not enforce RLS, so
  // any isolation "pass" would be a false positive. We do not claim a real pass from pg-mem.
  line();
  line("pg-mem loaded the full schema. NOTE: this only proves the DDL parses under pg-mem's");
  line("emulation; it does NOT run the store adapters (they need postgres.js on a live endpoint)");
  line("and pg-mem does NOT enforce RLS, so the tenant wall is UNVERIFIED here.");
  line();
  line("pg-mem could not fully verify the durable path; run against a real Postgres via DATABASE_URL for a true check.");
  process.exit(0);
}

async function main(): Promise<void> {
  const url = databaseUrl();
  if (url) {
    await runModeA(url);
  } else {
    await runModeB();
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  line();
  banner("RESULT: ERROR - the harness itself threw");
  line(msg);
  process.exit(1);
});
