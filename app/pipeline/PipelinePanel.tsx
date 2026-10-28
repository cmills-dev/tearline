"use client";

// The universe-screening panel. The user enters a mandate (sectors, size band, max leverage)
// plus optional universe filters (SIC codes, statuses, incorporation window, location) or an
// explicit list of Companies House numbers; this POSTs to /api/pipeline and renders the ranked
// suggestions, each with its cited why-now and warm path, alongside the honest note on how many
// candidates abstained (no catalyst) and how many exceeded the processing cap.

import { useState } from "react";
import type { OriginationSuggestion } from "@/lib/originate/suggestion";

interface PipelineResponse {
  suggestions?: OriginationSuggestion[];
  poolSize?: number;
  processed?: number;
  surfaced?: number;
  abstained?: number;
  skipped?: number;
  cap?: number;
  note?: string;
  error?: string;
}

function stripPrefix(id: string): string {
  return id.replace(/^(co:|firm:|cp:)/, "");
}

function SuggestionCard({ s, rank }: { s: OriginationSuggestion; rank: number }) {
  return (
    <div className="ruled" style={{ padding: "1.1rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "1rem", flexWrap: "wrap" }}>
        <h3 style={{ margin: 0 }}>
          <span className="legend" style={{ marginRight: "0.6rem" }}>{rank}.</span>
          {s.target.name}
        </h3>
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
    </div>
  );
}

// Parse a comma-or-space separated field into a trimmed, non-empty list.
function toList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export default function PipelinePanel() {
  const [sicCodes, setSicCodes] = useState("");
  const [sectors, setSectors] = useState("");
  const [statusActive, setStatusActive] = useState(true);
  const [minTurnover, setMinTurnover] = useState("");
  const [maxTurnover, setMaxTurnover] = useState("");
  const [maxLeverage, setMaxLeverage] = useState("");
  const [incorporatedFrom, setIncorporatedFrom] = useState("");
  const [location, setLocation] = useState("");
  const [chNumbers, setChNumbers] = useState("");
  const [size, setSize] = useState("50");
  const [cap, setCap] = useState("12");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PipelineResponse | null>(null);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const mandate: Record<string, unknown> = {};
      const sectorList = toList(sectors);
      if (sectorList.length) mandate.sectors = sectorList;
      if (minTurnover.trim()) mandate.minTurnover = Number(minTurnover) * 1e6;
      if (maxTurnover.trim()) mandate.maxTurnover = Number(maxTurnover) * 1e6;
      if (maxLeverage.trim()) mandate.maxLeverage = Number(maxLeverage);

      const explicit = toList(chNumbers);
      const payload: Record<string, unknown> = {
        mandate,
        cap: cap.trim() ? Number(cap) : undefined,
      };
      if (explicit.length) {
        payload.chNumbers = explicit;
      } else {
        payload.sicCodes = toList(sicCodes);
        payload.statuses = statusActive ? ["active"] : [];
        payload.size = size.trim() ? Number(size) : undefined;
        if (incorporatedFrom.trim()) payload.incorporatedFrom = incorporatedFrom.trim();
        if (location.trim()) payload.location = location.trim();
      }

      const res = await fetch("/api/pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as PipelineResponse;
      if (data.error) setError(data.error);
      else setResult(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const suggestions = result?.suggestions ?? [];

  return (
    <div>
      <form onSubmit={run} className="mt ruled pad">
        <span className="legend">Mandate</span>
        <div className="mandate-grid mt">
          <label className="opt span-2">
            Sectors (keywords, matched against the filed SIC text)
            <input className="ruled" type="text" value={sectors} onChange={(e) => setSectors(e.target.value)}
              placeholder="e.g. software, publishing" style={{ marginLeft: "0.5rem", padding: "0.4rem 0.6rem", flex: 1 }} />
          </label>
          <label className="opt">
            Min turnover (m)
            <input type="number" value={minTurnover} onChange={(e) => setMinTurnover(e.target.value)} placeholder="10" />
          </label>
          <label className="opt">
            Max turnover (m)
            <input type="number" value={maxTurnover} onChange={(e) => setMaxTurnover(e.target.value)} placeholder="250" />
          </label>
          <label className="opt">
            Max leverage (x)
            <input type="number" value={maxLeverage} onChange={(e) => setMaxLeverage(e.target.value)} placeholder="6" />
          </label>
          <label className="opt">
            Screening cap
            <input type="number" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="12" />
          </label>
        </div>

        <span className="legend" style={{ display: "block", marginTop: "1.4rem" }}>Universe filters</span>
        <div className="mandate-grid mt">
          <label className="opt span-2">
            SIC codes (register-exact)
            <input className="ruled" type="text" value={sicCodes} onChange={(e) => setSicCodes(e.target.value)}
              placeholder="e.g. 58290, 62012" style={{ marginLeft: "0.5rem", padding: "0.4rem 0.6rem", flex: 1 }} />
          </label>
          <label className="opt">
            Incorporated from
            <input className="ruled" type="date" value={incorporatedFrom} onChange={(e) => setIncorporatedFrom(e.target.value)}
              style={{ marginLeft: "0.5rem", padding: "0.35rem 0.5rem" }} />
          </label>
          <label className="opt">
            Location
            <input className="ruled" type="text" value={location} onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g. london" style={{ marginLeft: "0.5rem", padding: "0.4rem 0.6rem" }} />
          </label>
          <label className="opt">
            Pool size
            <input type="number" value={size} onChange={(e) => setSize(e.target.value)} placeholder="50" />
          </label>
          <label className="opt">
            <input type="checkbox" checked={statusActive} onChange={(e) => setStatusActive(e.target.checked)} />
            Active companies only
          </label>
          <label className="opt span-2">
            Or screen an explicit list of CH numbers (overrides the filters above)
            <input className="ruled" type="text" value={chNumbers} onChange={(e) => setChNumbers(e.target.value)}
              placeholder="e.g. 00445790, 03824658" style={{ marginLeft: "0.5rem", padding: "0.4rem 0.6rem", flex: 1 }} />
          </label>
        </div>

        <div className="mt">
          <button className="ruled" type="submit" disabled={loading} style={{ padding: "0.7rem 1.4rem", cursor: "pointer" }}>
            {loading ? "Screening the universe…" : "Screen the universe"}
          </button>
        </div>
      </form>

      {error && <p className="legend mt" style={{ color: "var(--accent)" }}>{error}</p>}

      {result && (
        <div className="mt">
          {result.note && <p className="legend">{result.note}</p>}
          {suggestions.length === 0 ? (
            <p className="prose small mt" style={{ color: "var(--ink-soft)" }}>
              No target in this universe carried a cited catalyst. We surface nothing rather than invent a reason.
            </p>
          ) : (
            <div className="mt" style={{ display: "grid", gap: "1rem" }}>
              {suggestions.map((s, i) => (
                <SuggestionCard key={i} s={s} rank={i + 1} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
