"use client";

import { useId } from "react";
import { entryHint, readEntry } from "./runEntryFlow";

// The primary action, styled as a document field, not a marketing button. One field for any UK
// company name or Companies House number: the line under it says which the text reads as, using
// the backend's own classifier, so the user knows before pressing whether a run starts at once
// or the register is searched first. It holds no company names of its own.
export default function EntryField({
  value,
  onChange,
  onSubmit,
  busy,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
}) {
  const hintId = useId();
  const reading = readEntry(value);
  const refused = reading.kind === "excluded";

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || reading.kind === "empty") return;
    onSubmit();
  }

  return (
    <form onSubmit={submit}>
      <div className="field">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Company name or Companies House number"
          aria-label="Company name or Companies House number"
          aria-describedby={hintId}
          autoComplete="off"
          spellCheck={false}
          autoFocus
        />
        <button type="submit" disabled={busy || reading.kind === "empty"} aria-busy={busy}>
          {reading.kind === "number" ? "Run" : "Look up"}
        </button>
      </div>
      <p
        id={hintId}
        className="legend mt"
        aria-live="polite"
        style={refused ? { color: "var(--accent)" } : undefined}
      >
        {entryHint(reading)}
      </p>
    </form>
  );
}
