// lib/run/view.ts
// What GET /api/run/[id] returns, as a pure function of the record.
//
// It lives here rather than inline in the route for one reason: the route can only be
// exercised with a request context (cookies, a tenant), and no test in this suite has one. The
// payload a poller reads is worth testing directly, so it is a function of the record and the
// route is a four-line wrapper around it.

import { isTerminal, type RunRecord, type RunStageRecord, type RunStatus } from "./types";

// A run in flight changes state every few seconds at most, so a one second poll is plenty. A
// terminal run should not be polled at all, so the field goes null.
export const POLL_AFTER_MS = 1000;

export interface RunView {
  id: string;
  input: string;
  status: RunStatus;
  stages: RunStageRecord[];
  // The stage currently running, or null between stages and once the run is over. This is the
  // one thing a progress display reads on every poll, so it is computed here rather than left
  // for each caller to scan the stage rows for.
  currentStage: string | null;
  startedAt: string;
  endedAt: string | null;
  elapsedMs: number;
  companyName: string | null;
  companyNumber: string | null;
  // Present once the manifest is assembled and saved. This is the key a sheet page opens.
  sheetKey: string | null;
  // Present only when the name was ambiguous: the run stopped rather than guessing.
  candidates: RunRecord["candidates"];
  abstentions: RunRecord["abstentions"];
  reason: string | null;
  durable: boolean;
  pollAfterMs: number | null;
}

export function runView(run: RunRecord, durable: boolean): RunView {
  const running = run.stages.find((s) => s.status === "running");
  const done = isTerminal(run.status);
  return {
    id: run.id,
    input: run.input,
    status: run.status,
    stages: run.stages,
    currentStage: done ? null : (running?.stage ?? null),
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    elapsedMs: run.elapsedMs,
    companyName: run.companyName,
    companyNumber: run.companyNumber,
    sheetKey: run.sheetKey,
    candidates: run.candidates,
    abstentions: run.abstentions,
    reason: run.reason,
    durable,
    pollAfterMs: done ? null : POLL_AFTER_MS,
  };
}
