// test/runJob.test.ts
// The run job (WP-BE06). No network and no model: global fetch is mocked, the vision provider
// is a stub, and the resolver is given a fixture-backed ResolveClient. The PDF is the same
// REAL frozen Companies House scan the WP-BE04 suite uses
// (eval/gold/fixtures/uk/02662226-2026-03-31/filing.pdf, 28 pages, image only), so a run goes
// through the genuine scan-or-text-layer decision rather than a sketch of one.
//
// No figure asserted here comes from eval/gold. The stubbed read invents its numbers, exactly
// as test/visionLive.test.ts does, because the gold figures are agent-keyed candidates until
// Cam's spot check and nothing in this package should depend on one.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { suite, test, assert, assertEqual } from "./harness";
import { InMemoryCache } from "../lib/cache/cache";
import { InMemoryRunStore } from "../lib/run/store";
import { runView } from "../lib/run/view";
import {
  abstentionsFrom,
  createRun,
  executeRun,
  runToCompletion,
  type RunDeps,
} from "../lib/run/runner";
import { MANIFEST_STAGES, type RunRecord, type RunStageStatus } from "../lib/run/types";
import { buildLiveFactManifest } from "../lib/sources/companiesHouseLive";
import type { ChFilingItem, ChProfile, ChSearchResult, ResolveClient } from "../lib/resolve/types";
import type { FactManifest } from "../lib/engine/types";
import type { LLMCallResult, LLMRequest, StructuredLLMProvider } from "../lib/llm/types";
import { BASE_LINE_KEYS, type BaseLineKey } from "../lib/vision/types";
import type { VisionWireOutput, WireLine } from "../lib/vision/schema";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCAN_PDF = new Uint8Array(
  readFileSync(join(HERE, "..", "eval", "gold", "fixtures", "uk", "02662226-2026-03-31", "filing.pdf")),
);
const MIGRATION = readFileSync(join(HERE, "..", "db", "migrations", "0011_runs.sql"), "utf8");

const TENANT = "run-tests";
const OTHER_TENANT = "someone-else";
const NUMBER = "02662226";

// --- Register payloads -------------------------------------------------------

const PROFILE: ChProfile = {
  company_name: "BRISTOL WATER PLC",
  company_number: NUMBER,
  company_status: "active",
  type: "plc",
  jurisdiction: "england-wales",
  date_of_creation: "1991-10-18",
  registered_office_address: { address_line_1: "Bridgwater Road", locality: "Bristol", country: "England" },
  accounts: { last_accounts: { made_up_to: "2026-03-31", type: "group" }, next_due: "2026-12-31" },
};

const META_URL = "https://document-api.company-information.service.gov.uk/document/FROZEN";
const CONTENT_URL = `${META_URL}/content`;

const ACCOUNTS_FILINGS: ChFilingItem[] = [
  {
    transaction_id: "AATX",
    category: "accounts",
    type: "AA",
    description: "accounts-with-accounts-type-group",
    description_values: { made_up_date: "2026-03-31" },
    date: "2026-09-11",
    pages: 28,
    links: { document_metadata: META_URL },
  },
];

const DOC_METADATA = {
  links: { document: CONTENT_URL },
  resources: { "application/pdf": { content_type: "application/pdf" } },
};

// Two active companies, both files accounts, both a compact match for "Meridian Logistics".
// The resolver must refuse to choose between them (Cam's decision of Tue 15 Sep).
const AMBIGUOUS_NAME = "Meridian Logistics";
const AMBIGUOUS_ITEMS = [
  {
    company_number: "07771001",
    title: "MERIDIAN LOGISTICS LIMITED",
    company_status: "active",
    company_type: "ltd",
    date_of_creation: "2011-10-03",
    address: { locality: "Leeds" },
  },
  {
    company_number: "09992002",
    title: "MERIDIAN LOGISTICS LTD",
    company_status: "active",
    company_type: "ltd",
    date_of_creation: "2016-04-19",
    address: { locality: "Southampton" },
  },
];

// --- The fixture ResolveClient ----------------------------------------------
// Counts its calls, so a test can prove an ambiguous run did the register lookups and stopped.

class FixtureResolveClient implements ResolveClient {
  searches = 0;
  profiles = 0;

  constructor(
    private readonly items: ChSearchResult["items"],
    private readonly profilesByNumber: Record<string, ChProfile>,
    private readonly filings: Record<string, ChFilingItem[]> = {},
  ) {}

  async search(): Promise<ChSearchResult> {
    this.searches++;
    return { items: this.items, total_results: this.items?.length ?? 0 };
  }

  async profile(number: string): Promise<ChProfile | null> {
    this.profiles++;
    return this.profilesByNumber[number] ?? null;
  }

  async filingHistory(number: string): Promise<ChFilingItem[]> {
    return this.filings[number] ?? [];
  }

  async leiForCompanyNumber(): Promise<string | null> {
    return null;
  }
}

function bristolClient(): FixtureResolveClient {
  return new FixtureResolveClient(
    [
      {
        company_number: NUMBER,
        title: "BRISTOL WATER PLC",
        company_status: "active",
        company_type: "plc",
        date_of_creation: "1991-10-18",
        address: { locality: "Bristol" },
      },
    ],
    { [NUMBER]: PROFILE },
    { [NUMBER]: ACCOUNTS_FILINGS },
  );
}

function ambiguousClient(): FixtureResolveClient {
  return new FixtureResolveClient(
    AMBIGUOUS_ITEMS,
    {
      "07771001": {
        company_name: "MERIDIAN LOGISTICS LIMITED",
        company_number: "07771001",
        company_status: "active",
        type: "ltd",
        accounts: { last_accounts: { made_up_to: "2025-12-31", type: "full" } },
      },
      "09992002": {
        company_name: "MERIDIAN LOGISTICS LTD",
        company_number: "09992002",
        company_status: "active",
        type: "ltd",
        accounts: { last_accounts: { made_up_to: "2025-09-30", type: "full" } },
      },
    },
    {
      "07771001": [{ ...ACCOUNTS_FILINGS[0], transaction_id: "T1" }],
      "09992002": [{ ...ACCOUNTS_FILINGS[0], transaction_id: "T2" }],
    },
  );
}

// --- Fetch mock (the builder's side of the world) ----------------------------

function jsonResponse(data: unknown, status = 200): Response {
  const text = JSON.stringify(data);
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => data,
    text: async () => text,
    headers: new Headers({ "content-length": String(text.length) }),
    body: null,
  } as unknown as Response;
}

function pdfResponse(bytes: Uint8Array): Response {
  return {
    status: 200,
    ok: true,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    headers: new Headers({ "content-length": String(bytes.byteLength) }),
    body: null,
  } as unknown as Response;
}

function installFetchMock(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === CONTENT_URL) return pdfResponse(SCAN_PDF);
    if (url.startsWith(META_URL)) return jsonResponse(DOC_METADATA);
    if (url.includes("/filing-history")) return jsonResponse({ total_count: 1, items: ACCOUNTS_FILINGS });
    if (url.includes("/charges")) return jsonResponse({ total_count: 0, unfiled_count: 0, items: [] });
    if (url.includes("/insolvency")) return jsonResponse({ errors: [] }, 404);
    if (url.includes("gleif")) return jsonResponse({ data: [] });
    if (url.includes("/company/")) return jsonResponse(PROFILE);
    return jsonResponse({}, 404);
  }) as typeof fetch;
}

// --- The stubbed vision read -------------------------------------------------
// Figures invented for this test. Enough lines land for the manifest to be a real one, and
// enough abstain for the abstention list to have something in it.

function abstainLine(key: BaseLineKey, reason: string): WireLine {
  return {
    key,
    status: "abstain",
    abstain_reason: reason,
    printed_label: "",
    figure_text: "",
    sign: "none",
    scale_caption: "",
    pdf_page_index: 0,
    printed_page_number: "",
    statement: "",
    period_end: "",
    note_reference: "",
  };
}

function found(key: BaseLineKey, over: Partial<WireLine>): WireLine {
  return {
    key,
    status: "found",
    abstain_reason: "",
    printed_label: "",
    figure_text: "",
    sign: "positive",
    scale_caption: "£m",
    pdf_page_index: 9,
    printed_page_number: "7",
    statement: "Statement of financial position",
    period_end: "2026-03-31",
    note_reference: "",
    ...over,
  };
}

const WIRE: VisionWireOutput = {
  document: {
    company_name_as_printed: "BRISTOL WATER PLC",
    period_end: "2026-03-31",
    currency: "GBP",
    basis: "company",
  },
  lines: [
    ...BASE_LINE_KEYS.map((k) => abstainLine(k, "not-printed")),
    found("turnover", { printed_label: "Turnover", figure_text: "142.6", statement: "Income statement" }),
    found("operating_profit", {
      printed_label: "Operating profit",
      figure_text: "18.2",
      statement: "Income statement",
    }),
    found("cash_at_bank", { printed_label: "Cash at bank and in hand", figure_text: "1.7", pdf_page_index: 10 }),
    found("net_assets", { printed_label: "Net assets", figure_text: "204.4", pdf_page_index: 10 }),
  ].reduce<WireLine[]>((acc, line) => {
    const i = acc.findIndex((l) => l.key === line.key);
    if (i >= 0) acc[i] = line;
    else acc.push(line);
    return acc;
  }, []),
  debt_note: {
    status: "abstain",
    abstain_reason: "not-printed",
    scale_caption: "",
    pdf_page_indexes: [],
    facilities: [],
    maturity_buckets: [],
  },
};

const USAGE = {
  provider: "mock",
  model: "claude-opus-5",
  inputTokens: 44_828,
  outputTokens: 884,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  durationMs: 1,
  attempts: 1,
  costUsd: 0,
  costGbp: 0,
  priced: true,
  stopReason: "end_turn",
};

class MockVisionProvider implements StructuredLLMProvider {
  readonly name = "mock";
  readonly model = "claude-opus-5";
  calls = 0;
  async complete(): Promise<string> {
    throw new Error("not used");
  }
  async send(_req: LLMRequest): Promise<LLMCallResult> {
    this.calls++;
    return { ok: true, text: JSON.stringify(WIRE), stopReason: "end_turn", usage: { ...USAGE } };
  }
}

// --- Helpers -----------------------------------------------------------------

interface Harnessed {
  deps: RunDeps;
  store: InMemoryRunStore;
  provider: MockVisionProvider;
  resolveClient: FixtureResolveClient;
  saved: { key: string; tenantId: string; manifest: FactManifest }[];
}

function harness(resolveClient: FixtureResolveClient, over: Partial<RunDeps> = {}): Harnessed {
  const store = new InMemoryRunStore();
  const provider = new MockVisionProvider();
  const saved: Harnessed["saved"] = [];
  return {
    store,
    provider,
    resolveClient,
    saved,
    deps: {
      store,
      resolveClient,
      // A fresh cache per harness, so a vision cache hit is only ever one this test put there.
      buildOptions: { visionDeps: { provider, cache: new InMemoryCache() } },
      persist: async (tenantId, key, manifest) => {
        saved.push({ tenantId, key, manifest });
      },
      ...over,
    },
  };
}

function stage(run: RunRecord, name: string) {
  return run.stages.find((s) => s.stage === name)!;
}

const ENDED: RunStageStatus[] = ["done", "skipped", "failed", "timed-out"];

// --- Async setup, awaited by the runner before run() -------------------------

let byName: RunRecord;
let byNumber: RunRecord;
let ambiguous: RunRecord;
let ambiguousProviderCalls = 0;
let midRun: RunRecord | null = null;
// The mid-run read must not depend on winning a race against the fixtures, which resolve fast
// enough that a whole run can finish before the first poll. The builder is parked on this gate
// until the read has happened, then released, so the run still finishes for the tests after it.
let releaseLive!: () => void;
const liveGate = new Promise<void>((resolve) => {
  releaseLive = resolve;
});
let afterRun: RunRecord | null = null;
let timedOut: RunRecord;
let timedOutBuildStarted = false;
let isolationLeak: RunRecord | null = null;
let nameHarness: Harnessed;
let numberHarness: Harnessed;

export async function registerRunJobTests(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.CH_API_KEY;
  installFetchMock();
  process.env.CH_API_KEY = "demo-key";

  // 1. A name, all the way to assemble.
  nameHarness = harness(bristolClient());
  byName = await runToCompletion(TENANT, "Bristol Water", nameHarness.deps);

  // 2. A company number, all the way to assemble.
  numberHarness = harness(bristolClient());
  byNumber = await runToCompletion(TENANT, NUMBER, numberHarness.deps);

  // 3. An ambiguous name: a pick list, and no vision call.
  const amb = harness(ambiguousClient());
  ambiguous = await runToCompletion(TENANT, AMBIGUOUS_NAME, amb.deps);
  ambiguousProviderCalls = amb.provider.calls;

  // 4. Mid-run polling. The run is started but NOT awaited; the store is read while the work
  //    is still going, exactly as the GET route reads it.
  const live = harness(bristolClient(), {
    build: async (number, options) => {
      // A real stage start, so the ledger shows a stage in flight, then park until the poller
      // below has read it. The runner's fold only lets the first start set startedAt, so the
      // builder's own fetch event after this changes nothing a poller sees.
      options.onStage?.({
        stage: "fetch",
        status: "start",
        detail: "parked for the mid-run read",
        at: new Date().toISOString(),
      });
      await liveGate;
      return buildLiveFactManifest(number, options);
    },
  });
  const created = await createRun(TENANT, "Bristol Water", live.deps);
  const working = executeRun(created, live.deps);
  for (let i = 0; i < 400; i++) {
    const seen = await live.store.load(TENANT, created.id);
    if (seen && seen.stages.some((s) => s.status === "running")) {
      midRun = seen;
      break;
    }
    await new Promise((r) => setTimeout(r, 2));
  }
  releaseLive();
  await working;
  afterRun = await live.store.load(TENANT, created.id);

  // 5. A stage that times out. The builder never settles; the fetch stage budget is 30
  //    milliseconds, so the watchdog fires on its first tick and the record stays readable.
  const hung = harness(bristolClient(), {
    budget: { totalMs: 60_000, stageMs: { resolve: 20_000, fetch: 30, extract: 30, verify: 30, assemble: 30 } },
    build: async (_number, options) => {
      timedOutBuildStarted = true;
      options.onStage?.({
        stage: "fetch",
        status: "start",
        detail: "PDF accounts",
        at: new Date().toISOString(),
      });
      // Never settles. buildLiveFactManifest has no abort seam, so this is what a hung stage
      // really looks like to the runner.
      return new Promise<FactManifest>(() => {});
    },
  });
  timedOut = await runToCompletion(TENANT, "Bristol Water", hung.deps);

  // 6. Tenant isolation on the store.
  isolationLeak = await nameHarness.store.load(OTHER_TENANT, byName.id);

  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.CH_API_KEY;
  else process.env.CH_API_KEY = originalKey;

  registerCases();
}

// --- Assertions --------------------------------------------------------------

function registerCases(): void {
  suite("runJob / a run is a job a user can watch");

  test("a run started with a name reaches assemble, with every stage recorded", () => {
    assertEqual(byName.status, "done", `status (reason: ${byName.reason})`);
    assertEqual(stage(byName, "assemble").status, "done", "assemble ended done");
    for (const name of MANIFEST_STAGES) {
      const row = stage(byName, name);
      assert(row.startedAt !== null, `${name} has a start instant`);
      assert(ENDED.includes(row.status), `${name} ended (status ${row.status})`);
      assert(row.endedAt !== null, `${name} has an end instant`);
      assert(row.detail.length > 0, `${name} carries a detail line`);
    }
  });

  test("a run started with a company number reaches assemble too", () => {
    assertEqual(byNumber.status, "done", `status (reason: ${byNumber.reason})`);
    assertEqual(byNumber.companyNumber, NUMBER, "the run knows which company it built");
    for (const name of MANIFEST_STAGES) {
      assert(ENDED.includes(stage(byNumber, name).status), `${name} ended`);
    }
  });

  test("both runs land on the same sheet key, because it is the same company", () => {
    assert(byName.sheetKey !== null, "the named run has a sheet key");
    assertEqual(byName.sheetKey, byNumber.sheetKey, "one company, one key");
    assertEqual(byName.sheetKey, "ch-02662226", "the key is the source-prefixed company number");
  });

  test("the assembled manifest was handed to the store under the run's tenant", () => {
    assertEqual(nameHarness.saved.length, 1, "exactly one save");
    assertEqual(nameHarness.saved[0].tenantId, TENANT, "saved under the run's tenant");
    assertEqual(nameHarness.saved[0].key, byName.sheetKey!, "saved under the key the run reports");
    assert(
      Object.keys(nameHarness.saved[0].manifest.facts).length > 0,
      "the saved manifest carries facts",
    );
  });

  test("the run reports what the sheet could not supply", () => {
    assert(byName.abstentions.length > 0, "at least one line abstained");
    for (const a of byName.abstentions) {
      assert(a.reason.length > 0, `${a.factId} carries a reason`);
      assert(a.factId.length > 0 && a.period.length > 0, "an abstention names its fact and period");
    }
  });

  test("the stages ran in order", () => {
    const starts = MANIFEST_STAGES.map((s) => stage(byName, s).startedAt!).filter(Boolean);
    const sorted = [...starts].sort();
    assertEqual(starts.join("|"), sorted.join("|"), "stage start instants are non-decreasing");
  });

  suite("runJob / an ambiguous name is never guessed");

  test("an ambiguous name ends needs-choice with the candidates", () => {
    assertEqual(ambiguous.status, "needs-choice", `status (reason: ${ambiguous.reason})`);
    assert(ambiguous.candidates !== null, "a pick list came back");
    assert(ambiguous.candidates!.length >= 2, `two or more candidates (${ambiguous.candidates!.length})`);
    assertEqual(ambiguous.candidates!.filter((c) => c.suggested).length, 1, "exactly one is marked suggested");
    assert((ambiguous.reason ?? "").length > 0, "the run says why it stopped");
    assertEqual(ambiguous.companyNumber, null, "no company was chosen");
    assertEqual(ambiguous.sheetKey, null, "no sheet was built");
  });

  test("an ambiguous run makes no vision call and fetches no document", () => {
    assertEqual(ambiguousProviderCalls, 0, "the model was never called");
    for (const name of ["fetch", "extract", "verify", "assemble"]) {
      assertEqual(stage(ambiguous, name).status, "pending", `${name} never started`);
    }
  });

  test("the pick list carries what a chooser needs to tell them apart", () => {
    for (const c of ambiguous.candidates!) {
      assert(c.number.length > 0 && c.name.length > 0, "a candidate has a number and a name");
      assert(c.why.length > 0, `${c.number} carries the resolver's plain reasons`);
    }
    const numbers = ambiguous.candidates!.map((c) => c.number);
    assertEqual(new Set(numbers).size, numbers.length, "no candidate appears twice");
  });

  test("a run that ends needs-choice is over, so a poller stops polling", () => {
    const view = runView(ambiguous, false);
    assertEqual(view.pollAfterMs, null, "nothing to poll for");
    assertEqual(view.currentStage, null, "no stage is in flight");
  });

  suite("runJob / a poll mid-run shows where the run is");

  test("a mid-run read names the stage in progress", () => {
    assert(midRun !== null, "the store was read while the run was still going");
    assertEqual(midRun!.status, "running", "the run was still running when it was read");
    const view = runView(midRun!, false);
    assert(view.currentStage !== null, `a stage was in flight (${view.currentStage})`);
    assert(
      MANIFEST_STAGES.includes(view.currentStage as (typeof MANIFEST_STAGES)[number]),
      `${view.currentStage} is one of the five stages`,
    );
    assertEqual(view.pollAfterMs, 1000, "the poller is told to come back");
    assertEqual(view.sheetKey, null, "no sheet key until the run is done");
  });

  test("after the run the same id returns the sheet key", () => {
    assert(afterRun !== null, "the run is still readable after it finished");
    assertEqual(afterRun!.status, "done", `status (reason: ${afterRun!.reason})`);
    const view = runView(afterRun!, false);
    assertEqual(view.sheetKey, "ch-02662226", "the sheet key is on the record");
    assertEqual(view.pollAfterMs, null, "and the poller is told to stop");
    assert(view.elapsedMs >= 0, "elapsed time is reported");
    assert(view.endedAt !== null, "the run carries an end instant");
  });

  suite("runJob / a stage timeout leaves a readable partial run");

  test("a stage that never answers leaves the run partial, not thrown away", () => {
    assert(timedOutBuildStarted, "the builder really was called");
    assertEqual(timedOut.status, "partial", "the run is partial");
    assertEqual(stage(timedOut, "fetch").status, "timed-out", "the stage that hung says so");
    assert((timedOut.reason ?? "").includes("fetch"), `the reason names the stage: ${timedOut.reason}`);
    assert((timedOut.reason ?? "").includes("timeout"), `the reason says what happened: ${timedOut.reason}`);
  });

  test("what finished before the timeout is still on the record", () => {
    const resolve = stage(timedOut, "resolve");
    assertEqual(resolve.status, "done", "resolve had already finished and kept its row");
    assert(resolve.detail.includes("BRISTOL WATER"), `resolve kept its detail line: ${resolve.detail}`);
    assertEqual(timedOut.companyNumber, NUMBER, "the company it had resolved is still named");
    assertEqual(stage(timedOut, "assemble").status, "pending", "a stage that never ran stays pending");
    assertEqual(timedOut.sheetKey, null, "no sheet, because none was assembled");
    assert(timedOut.endedAt !== null, "the run is over, not left hanging");
  });

  test("the timed-out stage carries its own reason, not a stack", () => {
    const detail = stage(timedOut, "fetch").detail;
    assert(detail.length > 0 && !detail.includes("at "), `a plain line: ${detail}`);
    assert(stage(timedOut, "fetch").endedAt !== null, "the stage has an end instant");
  });

  suite("runJob / the record is tenant-scoped");

  test("another tenant cannot load this tenant's run", () => {
    assertEqual(isolationLeak, null, "a run is invisible outside its tenant");
  });

  test("a run carries a row for all five stages from the moment it is created", async () => {
    const store = new InMemoryRunStore();
    const created = await createRun(TENANT, "anything", { store });
    assertEqual(created.stages.length, MANIFEST_STAGES.length, "five rows");
    assertEqual(created.status, "running", "and it starts running");
    for (const row of created.stages) assertEqual(row.status, "pending", `${row.stage} starts pending`);
    const back = await store.load(TENANT, created.id);
    assert(back !== null, "and it is readable at once, so the POST can hand back a pollable id");
  });

  suite("runJob / 0011_runs.sql");

  test("the migration is re-runnable", () => {
    assert(MIGRATION.includes("create table if not exists run"), "create table if not exists");
    assert(MIGRATION.includes("drop policy if exists run_tenant on run"), "drop policy if exists");
    assert(
      (MIGRATION.match(/create index if not exists/g) ?? []).length >= 2,
      "every index is create-if-not-exists",
    );
  });

  test("row-level security is forced on the run table", () => {
    assert(MIGRATION.includes("alter table run enable row level security"), "RLS enabled");
    assert(MIGRATION.includes("alter table run force  row level security"), "RLS forced");
    assert(
      MIGRATION.includes("using (tenant_id = current_setting('app.tenant_id', true))") &&
        MIGRATION.includes("with check (tenant_id = current_setting('app.tenant_id', true))"),
      "the policy shape is the one 0003_rls.sql and 0005_monitor.sql use",
    );
  });

  test("the run table hangs off tenant, so a deleted tenant takes its runs with it", () => {
    assert(MIGRATION.includes("references tenant(id) on delete cascade"), "foreign key with cascade");
    assert(MIGRATION.includes("primary key (tenant_id, id)"), "the tenant is part of the key");
  });

  suite("runJob / abstentions");

  test("only R4 facts are reported as abstentions, each with the pipeline's own reason", () => {
    const manifest = nameHarness.saved[0].manifest;
    const r4 = Object.values(manifest.facts).filter((f) => f.rung === "R4");
    const listed = abstentionsFrom(manifest);
    assertEqual(listed.length, r4.length, "one entry per abstaining fact and no more");
    const ids = new Set(listed.map((a) => a.factId));
    for (const f of r4) assert(ids.has(f.id), `${f.id} is listed`);
    const sorted = [...listed].sort((a, b) => (a.factId < b.factId ? -1 : 1));
    assertEqual(listed.map((a) => a.factId).join(","), sorted.map((a) => a.factId).join(","), "stable order");
  });
}
