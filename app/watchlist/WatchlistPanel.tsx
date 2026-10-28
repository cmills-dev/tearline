"use client";

// The client control for the watchlist page. Adds or removes a company by Companies House
// number, and triggers a re-check, each by POSTing to /api/monitor. The server re-renders
// the authoritative list, so this component holds only the current view returned by the
// last call, never a client-invented record. Every change event is shown with its
// provenance (the source register, the exact field that moved, and when it was read).

import { useRef, useState } from "react";
import Link from "next/link";

interface WatchEntry {
  chNumber: string;
  addedAt: string;
}
interface EventProvenance {
  source: string;
  field: string;
  retrievedAt: string;
  locator: string;
}
interface ChangeEvent {
  chNumber: string;
  kind: string;
  detail: string;
  provenance: EventProvenance;
  observedAt: string;
}
interface MonitorState {
  watchlist: WatchEntry[];
  events: ChangeEvent[];
  note?: string;
  checked?: number;
  changesFound?: number;
  error?: string;
}

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function WatchlistPanel({
  initialWatchlist,
  initialEvents,
}: {
  initialWatchlist: WatchEntry[];
  initialEvents: ChangeEvent[];
}) {
  const [watchlist, setWatchlist] = useState<WatchEntry[]>(initialWatchlist);
  const [events, setEvents] = useState<ChangeEvent[]>(initialEvents);
  const [chNumber, setChNumber] = useState("");
  const [busy, setBusy] = useState<null | "add" | "run" | string>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A sequence token so a slow earlier action's response cannot overwrite the state a newer action
  // already applied (add / remove / run can overlap on fast clicks). Only the latest call in flight
  // writes state; a superseded response is discarded.
  const postSeq = useRef(0);
  async function post(action: string, num?: string) {
    const seq = ++postSeq.current;
    setError(null);
    setNote(null);
    try {
      const res = await fetch("/api/monitor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, chNumber: num }),
      });
      const data = (await res.json()) as MonitorState;
      if (seq !== postSeq.current) return; // superseded by a newer action
      if (data.error) {
        setError(data.error);
        return;
      }
      setWatchlist(data.watchlist ?? []);
      setEvents(data.events ?? []);
      if (data.note) setNote(data.note);
      else if (action === "run") {
        setNote(
          `Re-checked ${data.checked ?? 0} ${(data.checked ?? 0) === 1 ? "company" : "companies"}, ${
            data.changesFound ?? 0
          } cited ${(data.changesFound ?? 0) === 1 ? "change" : "changes"}.`,
        );
      }
    } catch (err) {
      if (seq === postSeq.current) setError((err as Error).message);
    }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const num = chNumber.trim();
    if (!num) return;
    setBusy("add");
    await post("add", num);
    setChNumber("");
    setBusy(null);
  }

  async function remove(num: string) {
    setBusy(num);
    await post("remove", num);
    setBusy(null);
  }

  async function run() {
    setBusy("run");
    await post("run");
    setBusy(null);
  }

  return (
    <div>
      <form
        onSubmit={add}
        className="mt"
        style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", alignItems: "center" }}
      >
        <input
          className="ruled"
          type="text"
          value={chNumber}
          onChange={(e) => setChNumber(e.target.value)}
          placeholder="Companies House number (e.g. 00445790)"
          aria-label="Companies House number to watch"
          style={{ flex: "1 1 260px", padding: "0.7rem 0.9rem" }}
        />
        <button
          className="ruled"
          type="submit"
          disabled={busy === "add"}
          style={{ padding: "0.7rem 1.2rem", cursor: "pointer" }}
        >
          {busy === "add" ? "Adding…" : "Watch this company"}
        </button>
        <button
          className="ruled"
          type="button"
          onClick={run}
          disabled={busy === "run" || watchlist.length === 0}
          style={{ padding: "0.7rem 1.2rem", cursor: watchlist.length === 0 ? "default" : "pointer" }}
        >
          {busy === "run" ? "Re-checking…" : "Re-check now"}
        </button>
      </form>

      {error && <p className="legend mt" style={{ color: "var(--accent)" }}>{error}</p>}
      {note && <p className="legend mt">{note}</p>}

      <div className="mt">
        <span className="legend">Watched companies ({watchlist.length})</span>
        {watchlist.length === 0 ? (
          <p className="prose small mt" style={{ color: "var(--ink-soft)" }}>
            Nothing watched yet. Add a Companies House number above; the first re-check captures a
            baseline, and later re-checks report only what actually moved.
          </p>
        ) : (
          <div className="mt" style={{ display: "grid", gap: "0.4rem" }}>
            {watchlist.map((w) => (
              <div
                key={w.chNumber}
                className="ruled"
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  gap: "1rem",
                  padding: "0.7rem 0.9rem",
                }}
              >
                <span>
                  <Link
                    href={`https://find-and-update.company-information.service.gov.uk/company/${w.chNumber}`}
                    target="_blank"
                    style={{ color: "var(--accent)" }}
                  >
                    {w.chNumber}
                  </Link>{" "}
                  <span className="legend">added {when(w.addedAt)}</span>
                </span>
                <button
                  type="button"
                  onClick={() => remove(w.chNumber)}
                  disabled={busy === w.chNumber}
                  className="legend"
                  style={{ background: "none", border: "none", cursor: "pointer", color: "var(--ink-soft)" }}
                >
                  {busy === w.chNumber ? "Removing…" : "Remove"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt">
        <span className="legend">Recent cited changes ({events.length})</span>
        {events.length === 0 ? (
          <p className="prose small mt" style={{ color: "var(--ink-soft)" }}>
            No changes observed yet. An event appears only when a re-check finds a real movement on
            the public register, and every one carries its source.
          </p>
        ) : (
          <div className="mt" style={{ display: "grid", gap: "0.6rem" }}>
            {events.map((ev, i) => (
              <div key={i} className="ruled" style={{ padding: "0.9rem 1rem" }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "baseline",
                    gap: "1rem",
                    flexWrap: "wrap",
                  }}
                >
                  <strong>{ev.detail}</strong>
                  <span className="legend">{ev.kind}</span>
                </div>
                <div className="legend mt">
                  {ev.chNumber} · observed {when(ev.observedAt)}
                </div>
                <div className="legend">
                  Source: {ev.provenance.source} · field {ev.provenance.field} · read{" "}
                  {when(ev.provenance.retrievedAt)} ·{" "}
                  <Link href={ev.provenance.locator} target="_blank" style={{ color: "var(--accent)" }}>
                    public record →
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
