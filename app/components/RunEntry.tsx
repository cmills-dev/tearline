"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { RunCandidate } from "@/lib/run/types";
import EntryField from "./EntryField";
import {
  candidateFacts,
  formatElapsed,
  pickCandidate,
  pollRun,
  runToPoll,
  submitEntry,
  type EntryState,
  type FetchLike,
  type RunPoll,
} from "./runEntryFlow";

// One run entry for any UK name or number (WP-FE02). A number starts a run; a name is looked up
// on the register and, when more than one company could be meant, the user picks from the list
// (decision of record: an ambiguous name always shows a pick list). No match is an answer with
// the resolver's reason, shown as such. Everything on screen comes from the server's answer.
//
// While a run is in flight this shows its stages from GET /api/run/[id] and opens the sheet
// when it is saved. WP-FE03 replaces that inline view with the full progress page.
export default function RunEntry() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [state, setState] = useState<EntryState>({ phase: "idle" });
  // Bumped on every new submission, so an answer to an earlier one is dropped.
  const generation = useRef(0);

  const fetchImpl: FetchLike = (input, init) => fetch(input, init);

  async function apply(work: () => Promise<EntryState>, pending: EntryState) {
    const mine = ++generation.current;
    setState(pending);
    const next = await work();
    if (generation.current === mine) setState(next);
  }

  function submit() {
    const input = value.trim();
    if (!input) return;
    void apply(() => submitEntry(value, fetchImpl), { phase: "looking", input });
  }

  function pick(c: RunCandidate) {
    void apply(() => pickCandidate(c, fetchImpl), { phase: "looking", input: c.number });
  }

  function reset() {
    generation.current++;
    setState({ phase: "idle" });
  }

  // Poll a live run until it reaches a terminal state. Every answer is a new state object,
  // which schedules the next poll; a terminal state schedules none.
  useEffect(() => {
    const poll = runToPoll(state);
    if (!poll) return;
    const mine = generation.current;
    const timer = setTimeout(async () => {
      const next = await pollRun(poll.id, poll.input, fetchImpl);
      if (generation.current === mine) setState(next);
    }, poll.afterMs);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Open the sheet once it is saved.
  useEffect(() => {
    if (state.phase === "done") router.push(`/sheet/${encodeURIComponent(state.sheetKey)}`);
  }, [state, router]);

  const busy = state.phase === "looking" || state.phase === "running";

  return (
    <div>
      <EntryField value={value} onChange={setValue} onSubmit={submit} busy={busy} />
      <div aria-live="polite">
        <EntryOutcome state={state} onPick={pick} onReset={reset} />
      </div>
    </div>
  );
}

function EntryOutcome({
  state,
  onPick,
  onReset,
}: {
  state: EntryState;
  onPick: (c: RunCandidate) => void;
  onReset: () => void;
}) {
  switch (state.phase) {
    case "idle":
      return null;

    case "looking":
      return (
        <div className="ruled mt" style={{ padding: "1rem 1.2rem" }}>
          <span className="legend">Companies House register</span>
          <p className="prose small" style={{ marginTop: "0.4rem" }}>
            Looking up <strong>{state.input}</strong> on the register.
          </p>
        </div>
      );

    case "pick":
      return (
        <div className="ruled mt" style={{ padding: "1rem 1.2rem" }}>
          <span className="legend">
            {state.candidates.length === 1 ? "One company on the register" : `${state.candidates.length} companies on the register`}{" "}
            · pick the one you mean
          </span>
          <p className="prose small" style={{ marginTop: "0.4rem" }}>{state.reason}</p>
          <ul style={{ listStyle: "none", padding: 0, margin: "0.8rem 0 0" }}>
            {state.candidates.map((c) => (
              <li key={c.number} style={{ borderTop: "1px solid var(--rule)" }}>
                <button
                  type="button"
                  onClick={() => onPick(c)}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    background: "transparent",
                    border: "none",
                    padding: "0.75rem 0",
                    font: "inherit",
                    color: "inherit",
                    cursor: "pointer",
                  }}
                >
                  <strong>{c.name}</strong>
                  {c.suggested && state.candidates.length > 1 && (
                    <span className="legend" style={{ marginLeft: "0.6rem", color: "var(--accent)" }}>
                      Ranked first
                    </span>
                  )}
                  <span className="legend" style={{ display: "block", marginTop: "0.25rem" }}>
                    {candidateFacts(c)}
                  </span>
                  {c.matchedPreviousName && (
                    <span className="prose small" style={{ display: "block", marginTop: "0.25rem" }}>
                      Matched on a previous name: {c.matchedPreviousName}
                    </span>
                  )}
                  {c.why.length > 0 && (
                    <span className="prose small" style={{ display: "block", marginTop: "0.25rem", color: "var(--ink-soft)" }}>
                      {c.why.join("; ")}
                    </span>
                  )}
                  <span className="legend" style={{ display: "block", marginTop: "0.35rem", color: "var(--accent)" }}>
                    Run this company →
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <ResetLink onReset={onReset} label="None of these. Search again" />
        </div>
      );

    case "no-match":
      return (
        <div className="ruled mt" style={{ padding: "1rem 1.2rem" }}>
          <span className="legend">No company to run</span>
          <p className="prose small" style={{ marginTop: "0.4rem" }}>{state.reason}</p>
          <p className="prose small" style={{ marginTop: "0.4rem" }}>
            No filing was fetched and nothing was guessed. Try the registered name, or the company number from
            the Companies House register.
          </p>
          <ResetLink onReset={onReset} label="Search again" />
        </div>
      );

    case "running":
      return <RunStatusBox run={state.run} heading="Run in progress" />;

    case "done":
      return (
        <RunStatusBox run={state.run} heading="Sheet saved">
          <p className="prose small" style={{ marginTop: "0.6rem" }}>
            Opening <Link href={`/sheet/${encodeURIComponent(state.sheetKey)}`}>the sheet</Link>.
          </p>
        </RunStatusBox>
      );

    case "stopped":
      return (
        <RunStatusBox run={state.run} heading="The run stopped">
          <p className="prose small" style={{ marginTop: "0.6rem" }}>{state.reason}</p>
          {state.run.sheetKey && (
            <p className="prose small" style={{ marginTop: "0.4rem" }}>
              <Link href={`/sheet/${encodeURIComponent(state.run.sheetKey)}`}>Open what was saved</Link>.
            </p>
          )}
          <ResetLink onReset={onReset} label="Start another" />
        </RunStatusBox>
      );

    case "unavailable":
      return (
        <div className="ruled mt" style={{ padding: "1rem 1.2rem" }}>
          <span className="legend" style={{ color: "var(--accent)" }}>Could not start</span>
          <p className="prose small" style={{ marginTop: "0.4rem" }}>{state.message}</p>
          <ResetLink onReset={onReset} label="Try again" />
        </div>
      );
  }
}

function RunStatusBox({ run, heading, children }: { run: RunPoll; heading: string; children?: React.ReactNode }) {
  const who = [run.companyName, run.companyNumber].filter(Boolean).join(" ");
  return (
    <div className="ruled mt" style={{ padding: "1rem 1.2rem" }}>
      <span className="legend">
        {heading}
        {who ? ` · ${who}` : ""} · {formatElapsed(run.elapsedMs)}
      </span>
      <ol style={{ listStyle: "none", padding: 0, margin: "0.6rem 0 0" }}>
        {run.stages.map((s) => (
          <li
            key={s.stage}
            style={{ display: "flex", gap: "0.8rem", padding: "0.3rem 0", borderTop: "1px solid var(--rule)" }}
          >
            <span className="legend" style={{ minWidth: "6rem" }}>{s.stage}</span>
            <span className="legend" style={{ minWidth: "5.5rem", color: s.status === "failed" || s.status === "timed-out" ? "var(--accent)" : undefined }}>
              {s.status}
            </span>
            <span className="prose small" style={{ margin: 0 }}>{s.detail}</span>
          </li>
        ))}
      </ol>
      {!run.durable && run.status === "running" && (
        <p className="legend mt">
          Runs are held in memory on this deployment, so a server restart loses this one.
        </p>
      )}
      {children}
    </div>
  );
}

function ResetLink({ onReset, label }: { onReset: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onReset}
      className="legend mt"
      style={{ display: "block", background: "transparent", border: "none", padding: 0, cursor: "pointer", color: "var(--accent)" }}
    >
      {label}
    </button>
  );
}
