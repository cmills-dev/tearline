// lib/run/types.ts
// The run record: what a user watches while a sheet is being built.
//
// Until now the pipeline was a set of functions called inside a page render. A scan takes 35
// to 50 seconds to read (WP-BE04 measured it) and `/live` is capped at 30 seconds, so the
// work cannot live in a render. A RUN is that work turned into something with an id, a
// status per stage and a readable partial state, so the POST can return at once and the front
// end can poll.
//
// Every record is tenant-scoped. The tenant id is the enforcement key for the MNPI wall,
// exactly as it is on the tear sheet, the graph and the watchlist.

import { MANIFEST_STAGES, type ManifestStage } from "../vision/types";
import type { Candidate } from "../resolve/types";

export { MANIFEST_STAGES };
export type { ManifestStage };

// What a stage is doing. "pending" is a stage that has not started; the run record carries a
// row for every stage from the moment it is created, so a poll one millisecond in already
// shows the shape of the whole job rather than an empty list.
//
// "skipped" is a real outcome and not a failure: a filing with inline XBRL skips the vision
// extract, and a run with no scan skips verify.
//
// "timed-out" is distinct from "failed": the stage did not answer inside its own budget, and
// what it had produced up to that point is still on the record.
export type RunStageStatus = "pending" | "running" | "done" | "skipped" | "failed" | "timed-out";

export interface RunStageRecord {
  stage: ManifestStage;
  status: RunStageStatus;
  // One plain line, safe to show a user. Never a key, a header or a stack.
  detail: string;
  startedAt: string | null; // ISO, set on the FIRST start for this stage
  endedAt: string | null; // ISO
  elapsedMs: number | null; // set once the stage ends
}

// Where the run as a whole stands.
//   running       work is in flight; the stage rows say where.
//   needs-choice  the name was ambiguous. The resolver returned a pick list and the run
//                 stopped there, deliberately. No document was fetched and no model call was
//                 made. This is a CLEAN ending, not a failure.
//   done          a manifest was assembled and saved. `sheetKey` names it.
//   partial       a stage timed out or failed, and what was gathered before that is readable.
//                 `reason` says which stage and why.
//   failed        nothing usable came back. `reason` says why in one plain line.
export type RunStatus = "running" | "needs-choice" | "done" | "partial" | "failed";

// A candidate on a pick list, trimmed to what a chooser needs to see. The resolver's own
// Candidate carries more (esef hints, ranking internals); this is the shape the API returns.
export interface RunCandidate {
  number: string;
  name: string;
  status: string; // "active", "liquidation", "dissolved", ...
  type: string; // "ltd", "plc", "llp", ...
  incorporatedOn: string | null;
  locality: string | null;
  lastAccountsMadeUpTo: string | null;
  hasAccountsFiling: boolean | null;
  matchedPreviousName: string | null;
  // The resolver's own plain reasons for where this candidate ranked, in the order applied.
  why: string[];
  suggested: boolean; // the one the resolver would have picked, had it been allowed to guess
}

export function toRunCandidate(c: Candidate, suggestedNumber: string): RunCandidate {
  return {
    number: c.number,
    name: c.name,
    status: c.status,
    type: c.type,
    incorporatedOn: c.incorporatedOn,
    locality: c.locality,
    lastAccountsMadeUpTo: c.lastAccounts?.madeUpTo ?? null,
    hasAccountsFiling: c.hasAccountsFiling,
    matchedPreviousName: c.matchedPreviousName ?? null,
    why: c.why,
    suggested: c.number === suggestedNumber,
  };
}

// One line the sheet could not supply, with the reason the pipeline gave. Lifted off the R4
// facts so a poller sees what abstained without loading the whole manifest.
export interface RunAbstention {
  factId: string;
  label: string;
  period: string;
  reason: string;
}

export interface RunRecord {
  id: string;
  tenantId: string;
  // Exactly what the user typed, trimmed. Kept so a run can be explained after the fact.
  input: string;
  status: RunStatus;
  stages: RunStageRecord[];
  startedAt: string; // ISO
  endedAt: string | null; // ISO, set when the run reaches a terminal status
  // Milliseconds from startedAt to endedAt, or to now while the run is still going. Written
  // on every save so a reader never has to do clock arithmetic against a server it cannot see.
  elapsedMs: number;
  // Set once the manifest is saved to the tenant workspace. This is what the front end opens.
  sheetKey: string | null;
  companyNumber: string | null;
  companyName: string | null;
  // Present only on needs-choice.
  candidates: RunCandidate[] | null;
  abstentions: RunAbstention[];
  // Why the run ended where it did. Always set on needs-choice, partial and failed; null on a
  // clean done.
  reason: string | null;
}

export function emptyStages(): RunStageRecord[] {
  return MANIFEST_STAGES.map((stage) => ({
    stage,
    status: "pending" as const,
    detail: "",
    startedAt: null,
    endedAt: null,
    elapsedMs: null,
  }));
}

// A run is over when it is not running. Used by the GET route to decide whether to tell a
// poller to come back.
export function isTerminal(status: RunStatus): boolean {
  return status !== "running";
}
