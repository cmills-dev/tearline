"use client";

// The client's house sheet: the tenant's ACTIVE ClientSpec rendered against a real fact
// manifest, shown in the client's own field selection, labels, section order and style. It
// fetches /api/onboarding/housesheet (a route handler, so a spec just activated in memory is
// visible immediately, even with no database). Fields the source cannot support, or that sit
// below the client's resolution floor, are shown as an honest "not available", never guessed.
// Until a spec is activated the page says so and points to the setup wizard.

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";

interface RenderedField { key: string; label: string; value: string | null; rung: string | null; abstained: boolean; belowFloor: boolean }
interface RenderedSection { title: string; fields: RenderedField[] }
interface RenderedSheet {
  specVersion: number; specName: string; entityName: string;
  sections: RenderedSection[];
  styleTokens: { currencyDefault: string; dateFormat: string; voice: string };
  blocked: boolean; blockingFields: string[];
}
interface KbEntityRow { masterId: string; primaryName: string; sources: string[] }
interface GapItem { concept: string; supported: boolean; gapReason?: string; closesWith?: string }

const RUNG_LABEL: Record<string, string> = { R1: "R1 reported", R2: "R2 synthesised", R3: "R3 proxy", R4: "R4 abstain" };

// The engine concepts a client can remap a field to (RSI Phase 4). Keys match
// lib/clientspec/concepts.ts. Picking one persists a per-client synonym, so the same label maps
// to the chosen concept on the next sheet. This is the one-off-versus-persistent classifier at
// its simplest: a remap is persistent, a note is one-off.
const CONCEPT_OPTIONS: { key: string; label: string }[] = [
  { key: "turnover", label: "Turnover / revenue" },
  { key: "grossProfit", label: "Gross profit" },
  { key: "operatingProfit", label: "Operating profit" },
  { key: "ebitda", label: "EBITDA" },
  { key: "netDebt", label: "Net debt" },
  { key: "borrowings", label: "Total borrowings" },
  { key: "cash", label: "Cash" },
  { key: "leverage", label: "Net leverage" },
  { key: "interestCover", label: "Interest cover" },
  { key: "netCurrentAssets", label: "Net current assets" },
  { key: "netAssets", label: "Net assets" },
  { key: "totalAssets", label: "Total assets" },
  { key: "equity", label: "Equity" },
  { key: "sector", label: "Sector" },
];

export default function HouseSheetPage() {
  const [loading, setLoading] = useState(true);
  const [hasSpec, setHasSpec] = useState(false);
  const [sheet, setSheet] = useState<RenderedSheet | null>(null);

  // The Module 1 <-> Module 2 join: render the spec against the demo manifest, or against a chosen
  // knowledge-graph entity's accumulated cross-source facts (with its known-unknowns).
  const [entities, setEntities] = useState<KbEntityRow[]>([]);
  const [selectedEntity, setSelectedEntity] = useState<string>(""); // "" = demo manifest
  const [source, setSource] = useState<string>("demo");
  const [gaps, setGaps] = useState<GapItem[] | null>(null);

  // RSI Phase 4: sheet-level corrections, keyed by field. `openKey` is the field whose correction
  // panel is revealed; `remapChoice` and `noteText` hold the in-progress input for that field;
  // `saved` holds the inline confirmation once a correction posts.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [remapChoice, setRemapChoice] = useState<Record<string, string>>({});
  const [noteText, setNoteText] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, string>>({});

  // Remap: the client says this field should be a different concept. Persists a per-client synonym.
  async function remapField(label: string, conceptKey: string) {
    if (!conceptKey) return;
    const res = await fetch("/api/onboarding/correction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "remap", label, conceptKey }),
    });
    const d = await res.json().catch(() => ({}));
    setSaved((s) => ({ ...s, [label]: res.ok ? "saved, will apply next time" : (d.error ?? "could not save") }));
  }

  // Note: the client flags a value as wrong without picking a concept. One-off, persists nothing.
  async function flagField(label: string, note: string) {
    const res = await fetch("/api/onboarding/correction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "note", label, note }),
    });
    const d = await res.json().catch(() => ({}));
    setSaved((s) => ({ ...s, [label]: res.ok ? "flagged" : (d.error ?? "could not save") }));
  }

  // A sequence token so a fast entity switch cannot let a stale response win. Each load claims the
  // next sequence number; when its fetch resolves it only writes state if it is still the latest
  // load in flight, otherwise a newer selection has superseded it and this result is discarded.
  const loadSeq = useRef(0);
  async function load(entityId: string) {
    const seq = ++loadSeq.current;
    setLoading(true);
    const url = entityId ? `/api/onboarding/housesheet?entity=${encodeURIComponent(entityId)}` : "/api/onboarding/housesheet";
    try {
      const d = await (await fetch(url)).json();
      if (seq !== loadSeq.current) return; // superseded by a newer load
      setHasSpec(!!d.hasSpec);
      setSheet(d.sheet ?? null);
      setSource(d.source ?? "demo");
      setGaps(d.knownUnknowns?.items ?? null);
    } catch {
      // leave prior state
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }

  // Initial render against the demo manifest, plus the list of knowledge-graph entities to pick from.
  useEffect(() => {
    load("");
    fetch("/api/kb/entities").then((r) => r.json()).then((d) => setEntities(d.entities ?? [])).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return (
      <main className="frame doc">
        <section style={{ paddingTop: "2.6rem" }}>
          <span className="legend">House sheet · tenant-scoped</span>
          <p className="prose mt">Loading your house sheet…</p>
        </section>
      </main>
    );
  }

  if (!hasSpec || !sheet) {
    return (
      <main className="frame doc">
        <section style={{ paddingTop: "2.6rem" }}>
          <span className="legend">House sheet · not set up yet</span>
          <h1 style={{ marginTop: "0.6rem", maxWidth: "22ch" }}>No house sheet yet.</h1>
          <p className="prose mt">
            Once you complete setup, your sheets render in your own house style: your fields, your
            labels, your section order. It takes a couple of minutes.{" "}
            <Link href="/onboarding" style={{ color: "var(--accent)" }}>Set up your house sheet →</Link>
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="frame doc">
      <section style={{ paddingTop: "2.6rem" }}>
        <span className="legend">
          House sheet · spec v{sheet.specVersion} · {sheet.styleTokens.currencyDefault} · {sheet.styleTokens.dateFormat}
        </span>
        <h1 style={{ marginTop: "0.6rem", maxWidth: "26ch" }}>{sheet.specName}</h1>
        <p className="prose mt">
          Rendered against <strong>{sheet.entityName}</strong> through your own spec: your labels and
          section order. A field the source cannot support, or that sits below your resolution floor, is
          shown as <em>not available</em> rather than guessed.
          {source === "kb" ? " Facts are drawn from the knowledge graph, accumulated across every source." : ""}
        </p>

        <div className="mt" style={{ display: "flex", gap: "0.6rem", alignItems: "center", flexWrap: "wrap" }}>
          <span className="legend">Render against:</span>
          <select
            className="ruled"
            style={{ padding: "0.4rem 0.6rem" }}
            value={selectedEntity}
            onChange={(e) => { setSelectedEntity(e.target.value); load(e.target.value); }}
          >
            <option value="">Demo borrower (Meridian, single source)</option>
            {entities.map((en) => (
              <option key={en.masterId} value={en.masterId}>
                {en.primaryName} · knowledge graph ({en.sources.length} source{en.sources.length === 1 ? "" : "s"})
              </option>
            ))}
          </select>
          {entities.length === 0 && (
            <span className="legend">No graph entities yet. <Link href="/kb" style={{ color: "var(--accent)" }}>Ingest sources →</Link></span>
          )}
        </div>

        {sheet.blocked && (
          <p className="legend mt" style={{ color: "var(--accent)" }}>
            Blocked: {sheet.blockingFields.join(", ")} {sheet.blockingFields.length === 1 ? "is" : "are"} required by
            your spec but could not be served from this source. The sheet is shown for review, honestly incomplete.
          </p>
        )}

        <div className="mt" style={{ display: "grid", gap: "1.4rem" }}>
          {sheet.sections.map((section) => (
            <div key={section.title} className="ruled" style={{ padding: "1.1rem" }}>
              <span className="legend">{section.title}</span>
              <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "0.5rem" }}>
                <tbody>
                  {section.fields.map((f) => (
                    <React.Fragment key={f.key}>
                      <tr style={{ borderTop: "1px solid var(--rule)" }}>
                        <td className="prose small" style={{ padding: "0.5rem 0", width: "48%" }}>{f.label}</td>
                        <td className="prose small" style={{ padding: "0.5rem 0", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                          {f.abstained ? (
                            <span className="legend">not available{f.belowFloor ? " (below your floor)" : ""}</span>
                          ) : (
                            <strong>{f.value}</strong>
                          )}
                        </td>
                        <td className="legend" style={{ padding: "0.5rem 0 0.5rem 1rem", textAlign: "right", width: "20%" }}>
                          {f.rung ? RUNG_LABEL[f.rung] ?? f.rung : "abstained"}
                        </td>
                        <td className="legend" style={{ padding: "0.5rem 0 0.5rem 1rem", textAlign: "right", width: "7%" }}>
                          <button
                            className="legend"
                            style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--accent)" }}
                            onClick={() => setOpenKey((k) => (k === f.key ? null : f.key))}
                          >
                            {openKey === f.key ? "close" : "correct"}
                          </button>
                        </td>
                      </tr>
                      {openKey === f.key && (
                        <tr>
                          <td colSpan={4} style={{ padding: "0 0 0.7rem 0" }}>
                            <div className="ruled" style={{ padding: "0.7rem", display: "grid", gap: "0.6rem" }}>
                              <span className="legend">Correct &ldquo;{f.label}&rdquo;</span>
                              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                                <span className="legend" style={{ minWidth: "9rem" }}>This should be a different concept</span>
                                <select
                                  className="ruled"
                                  style={{ padding: "0.3rem 0.4rem" }}
                                  value={remapChoice[f.label] ?? ""}
                                  onChange={(e) => setRemapChoice((c) => ({ ...c, [f.label]: e.target.value }))}
                                >
                                  <option value="">pick a concept</option>
                                  {CONCEPT_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                                </select>
                                <button
                                  className="ruled"
                                  style={{ padding: "0.3rem 0.7rem", cursor: "pointer" }}
                                  disabled={!remapChoice[f.label]}
                                  onClick={() => remapField(f.label, remapChoice[f.label])}
                                >
                                  Remap
                                </button>
                              </div>
                              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                                <span className="legend" style={{ minWidth: "9rem" }}>This value looks wrong</span>
                                <input
                                  className="ruled"
                                  style={{ padding: "0.3rem 0.5rem", flex: "1 1 12rem" }}
                                  value={noteText[f.label] ?? ""}
                                  onChange={(e) => setNoteText((c) => ({ ...c, [f.label]: e.target.value }))}
                                  placeholder="what looks off? (optional)"
                                />
                                <button
                                  className="ruled legend"
                                  style={{ padding: "0.3rem 0.7rem", cursor: "pointer" }}
                                  onClick={() => flagField(f.label, noteText[f.label] ?? "")}
                                >
                                  Flag
                                </button>
                              </div>
                              {saved[f.label] && (
                                <span className="legend" style={{ color: "var(--accent)" }}>{saved[f.label]}</span>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>

        {source === "kb" && gaps && gaps.some((g) => !g.supported) && (
          <div className="ruled mt" style={{ padding: "1.1rem" }}>
            <span className="legend">Known-unknowns · what the graph cannot yet support</span>
            <ul className="prose small" style={{ paddingLeft: "1.1rem", margin: "0.4rem 0" }}>
              {gaps.filter((g) => !g.supported).map((g) => (
                <li key={g.concept}>
                  <strong>{g.concept}</strong>
                  {g.gapReason ? <span className="legend"> - {g.gapReason}</span> : null}
                  {g.closesWith ? <span className="legend"> · closes with: {g.closesWith}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <hr className="hairline" />
      <section>
        <span className="legend">
          <Link href="/onboarding" style={{ color: "var(--accent)" }}>Edit your setup →</Link> ·{" "}
          <Link href="/kb" style={{ color: "var(--accent)" }}>Knowledge graph →</Link> ·{" "}
          <Link href="/" style={{ color: "var(--accent)" }}>Home</Link>
        </span>
      </section>
    </main>
  );
}
