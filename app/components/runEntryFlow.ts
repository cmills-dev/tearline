// app/components/runEntryFlow.ts
// The logic behind the one run entry (WP-FE02), kept apart from the React so it can be tested
// under the zero-dependency harness without a DOM.
//
// What the entry does with what was typed:
//
//   A Companies House number (8 digits, a dropped-zero 6 or 7 digit number, or a UK prefix such
//   as SC, NI, OC, SO, NC) starts a run at once. The number names one entity, so there is
//   nothing to choose.
//
//   An overseas registration (FC, BR, SF, NF, OE) is refused before any call, with the
//   resolver's own reason. It files no UK accounts, so a run could only fail.
//
//   A name is looked up first. Where the backend offers a candidates lookup
//   (GET /api/resolve/candidates, requested of the backend lane in
//   docs/programme/reports/WP-FE02.md) the entry shows what the register holds and the user
//   picks. Until that route exists the name goes to POST /api/run, whose resolver either runs a
//   clear match, stops at `needs-choice` with a pick list, or ends with a plain no-match reason.
//   Either way an ambiguous name always ends in a pick list, never a guess (decision of record,
//   Tue 15 Sep).
//
// Nothing here invents a company, a number or a count. Every candidate, reason, stage and
// elapsed time shown comes from the server's answer, verbatim.

import { classifyInput } from "@/lib/resolve/numbers";
import type { RunCandidate, RunStageRecord, RunStatus } from "@/lib/run/types";

// ---------------------------------------------------------------------------
// Reading the input
// ---------------------------------------------------------------------------

export type EntryReading =
  | { kind: "empty" }
  | { kind: "number"; number: string; register: string }
  | { kind: "excluded"; number: string; reason: string }
  | { kind: "name"; name: string };

// The backend's own classifier (lib/resolve/numbers.ts), so the entry and the run can never
// disagree about whether a spaced, lower-case prefix number is a number.
export function readEntry(raw: string): EntryReading {
  if (!raw.trim()) return { kind: "empty" };
  return classifyInput(raw);
}

// The line under the field, saying what pressing the button will do. No company is named.
export function entryHint(reading: EntryReading): string {
  switch (reading.kind) {
    case "empty":
      return "A UK company name, or a Companies House number such as an 8-digit number or one starting SC, NI or OC.";
    case "number":
      return `Company number ${reading.number} (${reading.register}). This starts a run directly.`;
    case "excluded":
      return reading.reason;
    case "name":
      return "A name. The register is searched first; if more than one company could be meant, you pick.";
  }
}

// ---------------------------------------------------------------------------
// The state the entry is in
// ---------------------------------------------------------------------------

// What a poller reads from GET /api/run/[id]. The fields this component uses from RunView
// (lib/run/view.ts), restated so a malformed answer is caught here rather than in a render.
export interface RunPoll {
  id: string;
  input: string;
  status: RunStatus;
  stages: RunStageRecord[];
  currentStage: string | null;
  elapsedMs: number;
  companyName: string | null;
  companyNumber: string | null;
  sheetKey: string | null;
  candidates: RunCandidate[] | null;
  reason: string | null;
  durable: boolean;
  pollAfterMs: number | null;
}

export type EntryState =
  | { phase: "idle" }
  // Waiting on the register: the candidates lookup, or a run's resolve stage (then `runId` is
  // the run to keep polling).
  | { phase: "looking"; input: string; runId?: string; afterMs?: number }
  // The register holds one or more companies that could be meant. The user chooses.
  | { phase: "pick"; input: string; candidates: RunCandidate[]; reason: string }
  // Nothing on the register to run. A first-class answer with the resolver's reason, not an error.
  | { phase: "no-match"; input: string; reason: string }
  // A run is in flight for one company.
  | { phase: "running"; run: RunPoll }
  // The sheet is saved. The component opens it.
  | { phase: "done"; run: RunPoll; sheetKey: string }
  // The run ended short of a sheet: a stage timed out or failed. The reason is the run's own.
  | { phase: "stopped"; run: RunPoll; reason: string }
  // The request could not be made at all: signed out, no register key, throttled, offline.
  | { phase: "unavailable"; input: string; message: string };

// The state a poll puts the entry in.
//
// `failed` is only ever written by the run's resolver, for "none" (nothing on the register
// matches) and "excluded" (an overseas registration): lib/run/runner.ts writes every other
// dead end as `partial`. So a failed run is a no-match, and its reason is the resolver's own.
export function stateFromRun(run: RunPoll): EntryState {
  switch (run.status) {
    case "needs-choice":
      return {
        phase: "pick",
        input: run.input,
        candidates: run.candidates ?? [],
        reason: run.reason ?? "More than one company on the register could be meant.",
      };
    case "failed":
      return {
        phase: "no-match",
        input: run.input,
        reason: run.reason ?? "The register holds no company to run for this input.",
      };
    case "done":
      if (run.sheetKey) return { phase: "done", run, sheetKey: run.sheetKey };
      return { phase: "stopped", run, reason: run.reason ?? "The run ended without a saved sheet." };
    case "partial":
      return { phase: "stopped", run, reason: run.reason ?? "The run stopped before the sheet was complete." };
    case "running": {
      // A run spends its first seconds on the register. Until the resolver has named a
      // company, this is still a lookup, not a sheet being built.
      const resolve = run.stages.find((s) => s.stage === "resolve");
      if (!run.companyNumber && resolve?.status !== "done") {
        return { phase: "looking", input: run.input, runId: run.id, afterMs: run.pollAfterMs ?? undefined };
      }
      return { phase: "running", run };
    }
  }
}

// ---------------------------------------------------------------------------
// Reading server answers
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

const RUN_STATUSES: readonly RunStatus[] = ["running", "needs-choice", "done", "partial", "failed"];

export function isCandidate(v: unknown): v is RunCandidate {
  return isObject(v) && typeof v.number === "string" && typeof v.name === "string";
}

// A run view from the server, or null when the body is not one.
export function parseRunPoll(body: unknown): RunPoll | null {
  if (!isObject(body)) return null;
  const id = str(body.id);
  const status = str(body.status) as RunStatus | null;
  if (!id || !status || !RUN_STATUSES.includes(status)) return null;
  return {
    id,
    input: str(body.input) ?? "",
    status,
    stages: Array.isArray(body.stages) ? (body.stages as RunStageRecord[]) : [],
    currentStage: str(body.currentStage),
    elapsedMs: typeof body.elapsedMs === "number" ? body.elapsedMs : 0,
    companyName: str(body.companyName),
    companyNumber: str(body.companyNumber),
    sheetKey: str(body.sheetKey),
    candidates: Array.isArray(body.candidates) ? body.candidates.filter(isCandidate) : null,
    reason: str(body.reason),
    durable: body.durable === true,
    pollAfterMs: typeof body.pollAfterMs === "number" ? body.pollAfterMs : null,
  };
}

// The shape asked of the backend lane for GET /api/resolve/candidates?q=. See the report.
export interface CandidatesAnswer {
  kind: "resolved" | "pick" | "none" | "excluded";
  candidates: RunCandidate[];
  suggested: string | null;
  reason: string;
}

export function parseCandidatesAnswer(body: unknown): CandidatesAnswer | null {
  if (!isObject(body)) return null;
  const kind = str(body.kind);
  const reason = str(body.reason);
  if (!reason || (kind !== "resolved" && kind !== "pick" && kind !== "none" && kind !== "excluded")) return null;
  const candidates = Array.isArray(body.candidates) ? body.candidates.filter(isCandidate) : [];
  return { kind, candidates, suggested: str(body.suggested), reason };
}

// What a candidates answer does to the entry. A name always ends in a list to pick from when
// the register holds anything that fits, even a single clear match: the user sees which entity
// before a run spends anything on it. A number never reaches this path.
export function stateFromCandidates(input: string, answer: CandidatesAnswer): EntryState {
  if ((answer.kind === "resolved" || answer.kind === "pick") && answer.candidates.length > 0) {
    return { phase: "pick", input, candidates: answer.candidates, reason: answer.reason };
  }
  return { phase: "no-match", input, reason: answer.reason };
}

// A plain sentence for a response that is not a result. The server's own `error` line wins,
// because the routes already write them for a person to read.
export function unavailableMessage(status: number, body: unknown): string {
  const said = isObject(body) ? str(body.error) : null;
  if (said) return said;
  if (status === 401) return "You must be signed in to start a run.";
  if (status === 429) return "Too many runs in a short time. Wait a minute and try again.";
  if (status === 503) return "The register lookup is not configured on this deployment.";
  return `The server could not start this (status ${status}).`;
}

// ---------------------------------------------------------------------------
// Talking to the API
// ---------------------------------------------------------------------------

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export type StartOutcome = { ok: true; run: RunPoll } | { ok: false; state: EntryState };

// POST /api/run. The body carries exactly what the resolver should classify: a number, or a
// name when no candidates lookup was possible.
export async function startRun(input: string, fetchImpl: FetchLike): Promise<StartOutcome> {
  let res: Response;
  try {
    res = await fetchImpl("/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input }),
    });
  } catch {
    return { ok: false, state: { phase: "unavailable", input, message: "The server could not be reached." } };
  }
  const body = await readJson(res);
  if (res.status === 202 || res.ok) {
    // The POST answers with the new record's id and stages, not a full view. Read it as a
    // running run; the first poll fills in the rest.
    const run = parseRunPoll({ ...(isObject(body) ? body : {}), input: isObject(body) ? body.input ?? input : input });
    if (run) return { ok: true, run };
  }
  return { ok: false, state: { phase: "unavailable", input, message: unavailableMessage(res.status, body) } };
}

// GET /api/run/[id].
export async function pollRun(id: string, input: string, fetchImpl: FetchLike): Promise<EntryState> {
  let res: Response;
  try {
    res = await fetchImpl(`/api/run/${encodeURIComponent(id)}`, { cache: "no-store" });
  } catch {
    return { phase: "unavailable", input, message: "The server could not be reached while the run was in progress." };
  }
  const body = await readJson(res);
  const run = res.ok ? parseRunPoll(body) : null;
  if (run) return stateFromRun(run);
  // A 404 on an id just issued usually means runs are held in memory and the instance
  // restarted. The route says so in `note`; pass it on rather than guess.
  const note = isObject(body) ? str(body.note) : null;
  const message = unavailableMessage(res.status, body);
  return { phase: "unavailable", input, message: note ? `${message} ${note}` : message };
}

// GET /api/resolve/candidates?q=. null means the route is not there (404 or 405, or an answer
// that is not the documented shape), and the caller falls back to a run by name.
export async function lookupCandidates(
  name: string,
  fetchImpl: FetchLike,
): Promise<{ available: true; state: EntryState } | { available: false }> {
  let res: Response;
  try {
    res = await fetchImpl(`/api/resolve/candidates?q=${encodeURIComponent(name)}`, { cache: "no-store" });
  } catch {
    return { available: false };
  }
  if (res.status === 404 || res.status === 405) return { available: false };
  const body = await readJson(res);
  if (!res.ok) {
    return { available: true, state: { phase: "unavailable", input: name, message: unavailableMessage(res.status, body) } };
  }
  const answer = parseCandidatesAnswer(body);
  if (!answer) return { available: false };
  return { available: true, state: stateFromCandidates(name, answer) };
}

// What submitting the field does, as far as the first answer. Numbers start a run; overseas
// numbers are refused with the resolver's reason; names are looked up, falling back to a run
// by name. The component then polls any run this returns.
export async function submitEntry(raw: string, fetchImpl: FetchLike): Promise<EntryState> {
  const reading = readEntry(raw);
  switch (reading.kind) {
    case "empty":
      return { phase: "idle" };
    case "excluded":
      return { phase: "no-match", input: reading.number, reason: reading.reason };
    case "number": {
      const started = await startRun(reading.number, fetchImpl);
      return started.ok ? stateFromRun(started.run) : started.state;
    }
    case "name": {
      const looked = await lookupCandidates(reading.name, fetchImpl);
      if (looked.available) return looked.state;
      const started = await startRun(reading.name, fetchImpl);
      return started.ok ? stateFromRun(started.run) : started.state;
    }
  }
}

// Picking a candidate starts a run by its number, never by its name, so the run cannot
// re-resolve to a different company.
export async function pickCandidate(candidate: RunCandidate, fetchImpl: FetchLike): Promise<EntryState> {
  const started = await startRun(candidate.number, fetchImpl);
  return started.ok ? stateFromRun(started.run) : started.state;
}

// The id to keep polling, or null when the state is not a live run.
export function runToPoll(state: EntryState): { id: string; input: string; afterMs: number } | null {
  if (state.phase === "running") {
    return { id: state.run.id, input: state.run.input, afterMs: state.run.pollAfterMs ?? 1000 };
  }
  if (state.phase === "looking" && state.runId) {
    return { id: state.runId, input: state.input, afterMs: state.afterMs ?? 1000 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

// Seconds, from the server's measured elapsed time. One decimal under ten seconds.
export function formatElapsed(ms: number): string {
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`;
}

// One line about a candidate, from the register fields only. Absent fields are left out rather
// than filled.
export function candidateFacts(c: RunCandidate): string {
  const parts = [`No. ${c.number}`, c.type, c.status];
  if (c.locality) parts.push(c.locality);
  if (c.incorporatedOn) parts.push(`incorporated ${c.incorporatedOn}`);
  if (c.lastAccountsMadeUpTo) parts.push(`last accounts to ${c.lastAccountsMadeUpTo}`);
  else if (c.hasAccountsFiling === false) parts.push("no accounts filed");
  return parts.filter(Boolean).join(" · ");
}
