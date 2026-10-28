// lib/run/runner.ts
// The run job. Turns the pipeline from a set of functions into a job a user can watch.
//
// WP-BE04 measured a scanned filing at 35 to 50 seconds to read, and `/live` is capped at 30
// seconds in vercel.json. So the work cannot happen inside a page render or inside the
// request half of an API call. It happens here, after the POST has answered, under a budget,
// writing its progress to a tenant-scoped record as it goes.
//
// Two entry points, deliberately separate:
//
//   createRun()   synchronous-ish. Writes a `running` record with a row per stage and returns
//                 it. This is all POST /api/run needs to do before answering, so the two
//                 second budget is met by construction rather than by luck.
//   executeRun()  the work. The route hands this to after() from next/server, so it keeps
//                 running in the same invocation once the response has been flushed.
//
// THE BUDGET. Every stage has its own timeout and the run as a whole has 120 seconds. When
// either fires the run is marked `partial`, the stage that was in flight is marked
// `timed-out` with its reason, and everything gathered before that stays on the record. A
// timeout never throws the run away. The builder's own promise is abandoned rather than
// cancelled: buildLiveFactManifest has no abort seam, so the honest thing is to stop waiting,
// say so, and let the fetches it holds die with the invocation.
//
// AMBIGUITY. A name that does not clearly resolve ends the run at `needs-choice` with the
// resolver's pick list. No document is fetched, no model call is made, and no guess is
// recorded. This is Cam's settled decision of Tue 15 Sep, and it is enforced here by ordering:
// the resolver runs first, and the builder is only ever called with a company number.

import { randomUUID } from "node:crypto";
import {
  buildLiveFactManifest,
  type BuildLiveOptions,
} from "../sources/companiesHouseLive";
import { createResolveClient, resolveCompany } from "../resolve";
import type { ResolveClient } from "../resolve/types";
import type { FactManifest } from "../engine/types";
import { saveManifest, sourceKey } from "../workspace";
import { MANIFEST_STAGES, type ManifestStage, type StageEvent } from "../vision/types";
import { explainRunError } from "./plainError";
import { getRunStore, type RunStore } from "./store";
import { withGroupFollowing } from "./stages/group";
import {
  emptyStages,
  toRunCandidate,
  type RunAbstention,
  type RunRecord,
  type RunStageRecord,
} from "./types";

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------
// The whole run gets 120 seconds. Each stage gets its own slice, and the slices deliberately
// sum to more than 120: a run is not a sequence of worst cases, and the total is the real cap.
// A stage budget exists to stop ONE hung stage eating the whole run, so that the stages after
// it never get a chance. Extract is the long one because it is where a scan is read.
//
// The route declares maxDuration = 300, so the platform allows far more than 120. The gap is
// deliberate head-room: the run gives up on its own terms, with a written reason, well before
// the platform gives up on it without one.
export interface RunBudget {
  totalMs: number;
  stageMs: Record<ManifestStage, number>;
}

//
// WP-BE14 widened extract and verify. On 23 Sep (WP-QA04's 30 names, model on) five of six
// timeouts were work that had finished: verify took 30.7 to 31.6 s on four filings against a
// 30 s slice, and extract 72.7 s on one against 70 s, while every one of those runs was inside
// the 120 s total (86 to 101 s). The completed verify times ran 8.9 to 31.6 s and extract 18.9 to
// 72.7 s, so the old slices sat inside the normal spread, not beyond it. Extract now gets the
// 90 s a single vision call is allowed (LLM_VISION_TIMEOUT_MS), verify 50 s. The total is still
// the real cap and is unchanged, so no run can take longer than before; a hung stage is still cut.
export const DEFAULT_BUDGET: RunBudget = {
  totalMs: 120_000,
  stageMs: {
    resolve: 20_000,
    fetch: 30_000,
    extract: 90_000, // a vision read is 19 to 73 seconds (23 Sep, 29 reads); one call may take 90
    verify: 50_000, // the second read ran 9 to 32 seconds on 23 Sep
    assemble: 10_000,
  },
};

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------
// Everything a test replaces. The defaults are the live path, so a route passes nothing.

export interface RunDeps {
  store?: RunStore;
  // The register client the resolver uses. Tests inject a fixture-backed one.
  resolveClient?: ResolveClient;
  // The manifest builder. Tests inject one that hangs, to drive the timeout path.
  build?: (number: string, options: BuildLiveOptions) => Promise<FactManifest>;
  // Passed straight through to the builder: vision mode, verifier, provider and cache.
  buildOptions?: Omit<BuildLiveOptions, "onStage">;
  // Where an assembled manifest lands. Tests inject a spy.
  persist?: (tenantId: string, key: string, manifest: FactManifest) => Promise<void>;
  budget?: Partial<RunBudget>;
  // Injected so a test can drive elapsed time without waiting for it.
  now?: () => number;
  newId?: () => string;
}

function budgetFrom(partial?: Partial<RunBudget>): RunBudget {
  return {
    totalMs: partial?.totalMs ?? DEFAULT_BUDGET.totalMs,
    stageMs: { ...DEFAULT_BUDGET.stageMs, ...(partial?.stageMs ?? {}) },
  };
}

// ---------------------------------------------------------------------------
// Creating a run
// ---------------------------------------------------------------------------

// Write the `running` record and hand it back. Nothing here touches the register, the
// document API or a model, so POST /api/run answers in milliseconds and the two second
// acceptance is met by construction.
export async function createRun(
  tenantId: string,
  input: string,
  deps: RunDeps = {},
): Promise<RunRecord> {
  const store = deps.store ?? getRunStore();
  const now = deps.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  const run: RunRecord = {
    id: (deps.newId ?? randomUUID)(),
    tenantId,
    input: input.trim(),
    status: "running",
    stages: emptyStages(),
    startedAt,
    endedAt: null,
    elapsedMs: 0,
    sheetKey: null,
    companyNumber: null,
    companyName: null,
    candidates: null,
    abstentions: [],
    reason: null,
  };
  await store.save(run);
  return run;
}

// ---------------------------------------------------------------------------
// The stage ledger
// ---------------------------------------------------------------------------
// Folds StageEvents from the builder into the run's stage rows, and saves after every
// transition so a poll mid-run sees the stage in progress. Also owns the deadlines: it knows
// which stage is in flight and when it started, which is the only place that knowledge lives.

class StageLedger {
  private run: RunRecord;
  private readonly store: RunStore;
  private readonly now: () => number;
  private readonly budget: RunBudget;
  private readonly startedMs: number;
  // Saves are serialised through this chain. The builder fires stage events synchronously and
  // we must not have two writers racing on the same row, nor make the builder wait on a write.
  private writes: Promise<void> = Promise.resolve();

  current: ManifestStage | null = null;
  private currentSince = 0;
  // Set once the run has a terminal record. A timeout abandons the builder without cancelling
  // it, and the builder still holds onStage: its late events must not rewrite a record the
  // poller has already been told is over (WP-QA03 F1).
  private closed = false;

  constructor(run: RunRecord, store: RunStore, now: () => number, budget: RunBudget) {
    this.run = run;
    this.store = store;
    this.now = now;
    this.budget = budget;
    this.startedMs = Date.parse(run.startedAt);
  }

  get record(): RunRecord {
    return this.run;
  }

  private row(stage: ManifestStage): RunStageRecord {
    // Every stage has a row from creation, so this never misses.
    return this.run.stages.find((s) => s.stage === stage)!;
  }

  // Fold one event. Called from the builder's onStage callback and directly by the runner for
  // the stages it owns itself (the resolver's half of `resolve`, and the save half of `assemble`).
  apply(event: StageEvent): void {
    if (this.closed) return;
    const row = this.row(event.stage);
    if (event.status === "start") {
      // Only the FIRST start sets startedAt. The builder reports `resolve` and the runner has
      // already opened it; a second start must not reset the clock a poller is reading.
      if (!row.startedAt) row.startedAt = event.at;
      row.status = "running";
      row.detail = event.detail;
      this.current = event.stage;
      this.currentSince = this.now();
    } else {
      row.status = event.status === "done" ? "done" : event.status === "skipped" ? "skipped" : "failed";
      row.detail = event.detail;
      row.endedAt = event.at;
      row.elapsedMs = row.startedAt ? Math.max(0, Date.parse(event.at) - Date.parse(row.startedAt)) : null;
      if (this.current === event.stage) this.current = null;
    }
    this.touch();
    this.flush();
  }

  // A convenience for the runner's own events, which have no builder behind them.
  report(stage: ManifestStage, status: StageEvent["status"], detail: string): void {
    this.apply({ stage, status, detail, at: new Date(this.now()).toISOString() });
  }

  // How long the stage in flight has been running, and how long the run has. Null when
  // nothing is in flight.
  stageElapsed(): number | null {
    return this.current === null ? null : this.now() - this.currentSince;
  }

  runElapsed(): number {
    return this.now() - this.startedMs;
  }

  nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  // Which deadline, if any, has passed. Returns the reason line, or null.
  overdue(): string | null {
    const total = this.runElapsed();
    if (total > this.budget.totalMs) {
      const where = this.current ? `during ${this.current}` : "between stages";
      return `The run passed its ${Math.round(this.budget.totalMs / 1000)} second budget ${where}.`;
    }
    const stage = this.current;
    if (stage === null) return null;
    const limit = this.budget.stageMs[stage];
    const elapsed = this.stageElapsed() ?? 0;
    if (elapsed > limit) {
      return `The ${stage} stage passed its ${Math.round(limit / 1000)} second timeout.`;
    }
    return null;
  }

  // Mark whatever was in flight as timed out. Anything still pending stays pending, which is
  // honest: it never ran.
  markTimedOut(reason: string): void {
    // Nothing the abandoned builder says from here on is folded in.
    this.closed = true;
    const stage = this.current;
    if (stage) {
      const row = this.row(stage);
      row.status = "timed-out";
      row.detail = reason;
      row.endedAt = new Date(this.now()).toISOString();
      row.elapsedMs = row.startedAt ? Math.max(0, this.now() - Date.parse(row.startedAt)) : null;
      this.current = null;
    }
    this.touch();
  }

  patch(fields: Partial<RunRecord>): void {
    Object.assign(this.run, fields);
    this.touch();
  }

  private touch(): void {
    this.run.elapsedMs = Math.max(0, this.now() - this.startedMs);
  }

  // Queue a write. Never awaited by the builder's callback, so a slow store cannot stall a
  // stage, and never overlapping, so the last write wins in order.
  flush(): void {
    const snapshot = structuredClone(this.run);
    this.writes = this.writes.then(() => this.store.save(snapshot)).catch(() => {
      /* a progress write must not be able to fail a run */
    });
  }

  // Wait for every queued write. Called once, at the end, so the terminal record is durable
  // before the caller is told the run is over.
  async settle(): Promise<void> {
    this.flush();
    this.closed = true;
    await this.writes;
  }
}

// ---------------------------------------------------------------------------
// The deadline watchdog
// ---------------------------------------------------------------------------
// buildLiveFactManifest has no abort seam, so a stage timeout cannot cancel the work. What it
// can do is stop waiting. This races the builder against a poller that checks the ledger's
// deadlines several times a second and resolves with the reason when one passes.

const TICK_MS = 250;
class Timeout {
  constructor(readonly reason: string) {}
}

// The watchdog timer must NOT be unref'd. A hung stage means the builder's promise will never
// settle, so this tick is the only thing keeping the process alive and the only thing that can
// end the run. It is cleared in the finally below instead, which is what stops a finished run
// leaving a timer behind.
async function raceDeadline<T>(work: Promise<T>, ledger: StageLedger): Promise<T | Timeout> {
  let handle: ReturnType<typeof setTimeout> | null = null;
  let stop = false;
  const watchdog = new Promise<Timeout>((resolve) => {
    const tick = () => {
      if (stop) return;
      const reason = ledger.overdue();
      if (reason) return resolve(new Timeout(reason));
      handle = setTimeout(tick, TICK_MS);
    };
    handle = setTimeout(tick, TICK_MS);
  });
  try {
    return await Promise.race([work, watchdog]);
  } finally {
    stop = true;
    if (handle) clearTimeout(handle);
  }
}

// ---------------------------------------------------------------------------
// Abstentions
// ---------------------------------------------------------------------------

// Lift the R4 facts off the manifest with the reason the pipeline gave, so a poller sees what
// the sheet could not supply without loading the whole manifest. The reason is the attempt
// log's own words; nothing is composed here.
export function abstentionsFrom(manifest: FactManifest): RunAbstention[] {
  const out: RunAbstention[] = [];
  for (const fact of Object.values(manifest.facts)) {
    if (fact.rung !== "R4") continue;
    const log = fact.attemptLog ?? [];
    const said = log.find((e) => e.outcome !== "found") ?? log[log.length - 1];
    out.push({
      factId: fact.id,
      label: fact.label,
      period: fact.period,
      reason: said?.detail || "No reason was recorded.",
    });
  }
  out.sort((a, b) => (a.factId < b.factId ? -1 : a.factId > b.factId ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// Executing a run
// ---------------------------------------------------------------------------

// Do the work and leave the record in a terminal state. Never throws: every exit writes a
// readable record, because the caller is after() and nobody is listening for a rejection.
export async function executeRun(run: RunRecord, deps: RunDeps = {}): Promise<RunRecord> {
  const store = deps.store ?? getRunStore();
  const now = deps.now ?? Date.now;
  const budget = budgetFrom(deps.budget);
  const ledger = new StageLedger(structuredClone(run), store, now, budget);
  const build = deps.build ?? withGroupFollowing(buildLiveFactManifest);
  const persist = deps.persist ?? saveManifest;

  try {
    // --- Stage 1 (the runner's half): who is this? --------------------------------------
    ledger.report("resolve", "start", `Looking up "${run.input}" on the register`);
    const client = deps.resolveClient ?? createResolveClient();
    const resolved = await raceDeadline(resolveCompany(run.input, client), ledger);

    if (resolved instanceof Timeout) {
      return await finishTimedOut(ledger, resolved.reason);
    }

    if (resolved.kind === "pick") {
      // The settled decision: an ambiguous name returns a pick list, never a guess. The run
      // ends here, cleanly. Nothing was fetched and no model was called, because the builder
      // is the only thing that does either and it has not been reached.
      ledger.report("resolve", "done", `${resolved.candidates.length} companies could be the one`);
      ledger.patch({
        status: "needs-choice",
        candidates: resolved.candidates.map((c) => toRunCandidate(c, resolved.suggested)),
        reason: resolved.reason,
        endedAt: new Date(now()).toISOString(),
      });
      await ledger.settle();
      return ledger.record;
    }

    if (resolved.kind !== "resolved") {
      // "none" (nothing on the register matches) and "excluded" (an overseas registration,
      // which files no UK accounts of its own). Both are dead ends with a plain reason, and
      // neither is a bug, so the reason is shown as-is and nothing is retried.
      ledger.report("resolve", "failed", resolved.reason);
      ledger.patch({
        status: "failed",
        reason: resolved.reason,
        endedAt: new Date(now()).toISOString(),
      });
      await ledger.settle();
      return ledger.record;
    }

    const company = resolved.company;
    ledger.patch({ companyNumber: company.number, companyName: company.name });
    ledger.report("resolve", "done", `${company.name} ${company.number}: ${resolved.reason}`);

    // --- Stages 1 to 5 (the builder): the sheet ------------------------------------------
    // The builder re-opens `resolve` to say which filing it picked, then runs fetch, extract,
    // verify and assemble. Its events land straight on the ledger.
    const options: BuildLiveOptions = {
      ...(deps.buildOptions ?? {}),
      onStage: (event) => ledger.apply(event),
    };
    const built = await raceDeadline(build(company.number, options), ledger);
    if (built instanceof Timeout) {
      return await finishTimedOut(ledger, built.reason);
    }

    // --- Save, and name the sheet --------------------------------------------------------
    // The builder's own `assemble` stage has already reported done. Saving is the runner's
    // half of it: without a sheet key there is nothing for the front end to open, so a save
    // failure is a partial run and not a done one.
    const key = sourceKey("ch", built);
    try {
      await persist(run.tenantId, key, built);
    } catch (e) {
      ledger.report("assemble", "failed", `The sheet could not be saved: ${message(e)}`);
      ledger.patch({
        status: "partial",
        abstentions: abstentionsFrom(built),
        companyName: built.entity.companyName || company.name,
        reason: `The sheet was assembled but could not be saved: ${message(e)}`,
        endedAt: new Date(now()).toISOString(),
      });
      await ledger.settle();
      return ledger.record;
    }

    const abstentions = abstentionsFrom(built);
    ledger.patch({
      status: "done",
      sheetKey: key,
      companyName: built.entity.companyName || company.name,
      companyNumber: built.entity.companyNumber || company.number,
      abstentions,
      endedAt: new Date(now()).toISOString(),
    });
    ledger.report(
      "assemble",
      "done",
      `${Object.keys(built.facts).length} facts saved as ${key}, ${abstentions.length} abstaining`,
    );
    await ledger.settle();
    return ledger.record;
  } catch (e) {
    // Anything unforeseen. The record still has to be readable, so whatever the stages managed
    // stays, and the reason is one plain line.
    const stage = ledger.current;
    if (stage) ledger.report(stage, "failed", message(e));
    ledger.patch({
      status: "partial",
      reason: `The run stopped at ${stage ?? "an unnamed step"}: ${message(e)}`,
      endedAt: new Date(now()).toISOString(),
    });
    await ledger.settle();
    return ledger.record;
  }
}

// A stage ran out of time. The run is PARTIAL, not failed: every stage that finished keeps its
// row and its detail, and the stage that did not finish says so in its own words.
async function finishTimedOut(ledger: StageLedger, reason: string): Promise<RunRecord> {
  ledger.markTimedOut(reason);
  ledger.patch({
    status: "partial",
    reason,
    endedAt: ledger.nowIso(),
  });
  await ledger.settle();
  return ledger.record;
}

// Plain words for the record: a raw transport error ("fetch failed") is explained (WP-BE14).
function message(e: unknown): string {
  return explainRunError(e);
}

// Create and execute in one call, awaiting the work. Used by tests and by any caller that is
// not a serverless request. The ROUTE does not use this: it calls createRun, answers, and
// hands executeRun to after().
export async function runToCompletion(
  tenantId: string,
  input: string,
  deps: RunDeps = {},
): Promise<RunRecord> {
  const created = await createRun(tenantId, input, deps);
  return executeRun(created, deps);
}

export { MANIFEST_STAGES };
