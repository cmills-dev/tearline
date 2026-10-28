"use client";

// The LIVE origination panel. The user enters a real Companies House number (plus an
// optional max-leverage mandate); this POSTs to /api/originate and renders the honest
// result: a warm-path + cited "why now" suggestion, an abstention note (no cited
// catalyst), or the graceful 400 when CH_API_KEY is absent. A found suggestion can be
// saved to the tenant's shortlists, which are listed below.

import { useState } from "react";
import Link from "next/link";
import type { OriginationSuggestion } from "@/lib/originate/suggestion";
import type { SavedSuggestion } from "@/lib/workspace";
import { saveShortlistAction } from "./actions";

interface ApiResponse {
  suggestion?: OriginationSuggestion | null;
  note?: string;
  error?: string;
}

function stripPrefix(id: string): string {
  return id.replace(/^(co:|firm:|cp:)/, "");
}

function SuggestionCard({
  s,
  savedAt,
}: {
  s: OriginationSuggestion;
  savedAt?: string;
}) {
  return (
    <div className="ruled" style={{ padding: "1.1rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "1rem", flexWrap: "wrap" }}>
        <h3 style={{ margin: 0 }}>{s.target.name}</h3>
        <span className="legend" style={{ color: s.tier === "warm" ? "var(--accent)" : "var(--ink-soft)" }}>
          {s.tier === "warm" ? "WARM · you have a path" : "COLD · no warm path"} · score {s.score.total.toFixed(2)}
        </span>
      </div>
      {s.target.chNumber && (
        <span className="legend">Companies House {s.target.chNumber}{s.target.lei ? ` · LEI ${s.target.lei}` : ""}</span>
      )}

      <div className="mt"><span className="legend">Why now</span>
        <ul className="prose small" style={{ paddingLeft: "1.1rem", margin: "0.3rem 0" }}>
          {s.whyNow.map((sig, j) => (
            <li key={j}>
              {sig.detail}{" "}
              <span className="legend">[{sig.rung} · {sig.source?.documentName ?? "cited"}]</span>
              {sig.caveat ? <span className="legend"> - {sig.caveat}</span> : null}
            </li>
          ))}
        </ul>
      </div>

      <div className="mt"><span className="legend">Why you</span>
        {s.warmPath ? (
          <p className="prose small" style={{ margin: "0.3rem 0" }}>
            {s.warmPath.hops.map((h, k) => (
              <span key={k}>{k === 0 ? "You" : ""} <span className="legend">-{h.rel}→</span> {stripPrefix(h.toId)} </span>
            ))}
            <span className="legend">(min confidence {(s.warmPath.minConfidence * 100).toFixed(0)}%; every hop cited)</span>
          </p>
        ) : (
          <p className="prose small" style={{ margin: "0.3rem 0", color: "var(--ink-soft)" }}>
            No warm path in your network. We will not invent one.
          </p>
        )}
      </div>

      {s.abstentions.length > 0 && (
        <div className="mt"><span className="legend">Not established: {s.abstentions.join("; ")}</span></div>
      )}
      {savedAt && (
        <div className="mt"><span className="legend">Saved {new Date(savedAt).toLocaleString("en-GB")}</span></div>
      )}
    </div>
  );
}

export default function LivePanel({ initialShortlists }: { initialShortlists: SavedSuggestion[] }) {
  const [chNumber, setChNumber] = useState("");
  const [maxLeverage, setMaxLeverage] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<OriginationSuggestion | null>(null);
  const [query, setQuery] = useState<{ chNumber: string; mandate: { maxLeverage?: number } } | null>(null);
  const [shortlists, setShortlists] = useState<SavedSuggestion[]>(initialShortlists);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    const n = chNumber.trim();
    if (!n) return;
    setLoading(true);
    setError(null);
    setNote(null);
    setSuggestion(null);
    setQuery(null);
    setSaved(false);
    try {
      const mandate = maxLeverage.trim() ? { maxLeverage: Number(maxLeverage) } : {};
      const res = await fetch("/api/originate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chNumber: n, mandate }),
      });
      const data = (await res.json()) as ApiResponse;
      if (data.error) {
        setError(data.error);
      } else if (data.suggestion) {
        setSuggestion(data.suggestion);
        setQuery({ chNumber: n, mandate });
      } else {
        setNote(data.note ?? "Abstained - no cited catalyst established for this target.");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!query) return;
    setSaving(true);
    try {
      // The server re-derives the suggestion from the engine; we send only the query, never the
      // rendered suggestion, so nothing client-side can enter the saved record.
      const res = await saveShortlistAction(query);
      setShortlists(res.list);
      if (res.saved) setSaved(true);
      else setNote(res.note ?? "Nothing saved.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <form onSubmit={run} className="mt" style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", alignItems: "center" }}>
        <input
          className="ruled"
          type="text"
          value={chNumber}
          onChange={(e) => setChNumber(e.target.value)}
          placeholder="Companies House number (e.g. 00445790)"
          aria-label="Companies House number"
          style={{ flex: "1 1 260px", padding: "0.7rem 0.9rem" }}
        />
        <input
          className="ruled"
          type="text"
          value={maxLeverage}
          onChange={(e) => setMaxLeverage(e.target.value)}
          placeholder="Max leverage (optional)"
          aria-label="Max leverage mandate"
          inputMode="decimal"
          style={{ flex: "0 1 180px", padding: "0.7rem 0.9rem" }}
        />
        <button className="ruled" type="submit" disabled={loading} style={{ padding: "0.7rem 1.2rem", cursor: "pointer" }}>
          {loading ? "Originating…" : "Originate for this target"}
        </button>
      </form>

      {error && <p className="legend mt" style={{ color: "var(--accent)" }}>{error}</p>}
      {note && <p className="legend mt">{note}</p>}

      {suggestion && (
        <div className="mt" style={{ display: "grid", gap: "0.8rem" }}>
          <SuggestionCard s={suggestion} />
          <div>
            <button
              className="ruled"
              type="button"
              onClick={save}
              disabled={saving || saved}
              style={{ padding: "0.55rem 1.1rem", cursor: saved ? "default" : "pointer" }}
            >
              {saved ? "Saved to workspace ✓" : saving ? "Saving…" : "Save to workspace"}
            </button>
          </div>
        </div>
      )}

      <div className="mt">
        <span className="legend">
          Saved shortlists ({shortlists.length}) ·{" "}
          <Link href="/workspace" style={{ color: "var(--accent)" }}>Your workspace →</Link>
        </span>
        {shortlists.length === 0 ? (
          <p className="prose small mt" style={{ color: "var(--ink-soft)" }}>
            Nothing saved yet. Originate for a real target above, then save the suggestion.
          </p>
        ) : (
          <div className="mt" style={{ display: "grid", gap: "0.8rem" }}>
            {shortlists.map((s, i) => (
              <SuggestionCard key={i} s={s} savedAt={s.savedAt} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
