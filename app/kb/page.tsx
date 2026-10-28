"use client";

// The knowledge-graph browser (Module 2, data layer). It shows the master-ID entity spine and,
// per entity, the facts accumulated ACROSS sources with their freshest as-of and resolution
// rung. The point it makes visible: the same company ingested from Companies House and from ESEF
// resolves to ONE entity whose coverage carries facts from both, and a newer filing supersedes an
// older one. This is the compounding data asset, rendered honestly (every fact keeps its source
// and rung; nothing is merged into a fabricated consensus).

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

interface EntityRow { masterId: string; primaryName: string; sources: string[]; identifiers: { chNumber?: string; cik?: string; lei?: string } }
interface CoverageItem { metric: string; period: string; rung: string; sources: string[]; asOf: string }
interface Instrument { instrumentId: string; kind: string; label: string; source: string }
interface GapItem { concept: string; supported: boolean; rung?: string; sources: string[]; gapReason?: string; closesWith?: string }
interface EntityDetail {
  entity: EntityRow;
  coverage: { items: CoverageItem[]; sourceCount: number };
  instruments?: Instrument[];
  knownUnknowns?: { supportedCount: number; gapCount: number; items: GapItem[] };
}

const RUNG_LABEL: Record<string, string> = { R1: "R1 reported", R2: "R2 synthesised", R3: "R3 proxy", R4: "R4 abstain" };

export default function KbPage() {
  const [entities, setEntities] = useState<EntityRow[]>([]);
  const [selected, setSelected] = useState<EntityDetail | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadEntities = useCallback(async () => {
    const r = await fetch("/api/kb/entities");
    const d = await r.json();
    if (r.ok) setEntities(d.entities ?? []);
  }, []);

  useEffect(() => { loadEntities(); }, [loadEntities]);

  async function ingest(key: string, label: string) {
    setBusy(true);
    setNote(null);
    try {
      const r = await fetch("/api/kb/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      const d = await r.json();
      if (!r.ok) { setNote(d.error ?? "Ingest failed."); return; }
      setNote(`Ingested ${label}: ${d.factsIngested} facts onto entity ${d.masterId} (${d.entityName}).`);
      await loadEntities();
    } finally {
      setBusy(false);
    }
  }

  async function openEntity(masterId: string) {
    const r = await fetch(`/api/kb/entity?id=${encodeURIComponent(masterId)}`);
    const d = await r.json();
    if (r.ok) setSelected(d);
  }

  return (
    <main className="frame doc">
      <section style={{ paddingTop: "2.6rem" }}>
        <span className="legend">Knowledge graph · master-ID spine · shared Tier-0 plane</span>
        <h1 style={{ marginTop: "0.6rem", maxWidth: "26ch" }}>One entity, every source.</h1>
        <p className="prose mt">
          The same company seen through Companies House, SEC and ESEF resolves to one master entity,
          and its facts accumulate across sources with amendment precedence. Ingest the demo sources
          below and watch a single entity gather facts from each, every one keeping its own source and
          resolution rung. Public facts only; this plane is shared, never tenant-private.
        </p>

        <div className="mt" style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
          <button className="ruled" disabled={busy} style={{ padding: "0.5rem 1rem", cursor: "pointer" }} onClick={() => ingest("meridian", "Meridian (fixture, CH-style)")}>
            Ingest Meridian (fixture)
          </button>
          <button className="ruled" disabled={busy} style={{ padding: "0.5rem 1rem", cursor: "pointer" }} onClick={() => ingest("redacta", "Redacta (fixture)")}>
            Ingest Redacta (fixture)
          </button>
          <button className="ruled" disabled={busy} style={{ padding: "0.5rem 1rem", cursor: "pointer" }} onClick={() => ingest("meridian-esef", "Meridian via ESEF (same entity, 2nd source)")}>
            Ingest Meridian via ESEF (2nd source)
          </button>
        </div>
        {note && <p className="legend mt" style={{ color: "var(--accent)" }}>{note}</p>}

        <div className="mt" style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: "1.5rem", alignItems: "start" }}>
          <aside className="ruled" style={{ padding: "1rem" }}>
            <span className="legend">Entities ({entities.length})</span>
            <div className="mt" style={{ display: "grid", gap: "0.4rem" }}>
              {entities.length === 0 && <span className="prose small">None yet. Ingest a source above.</span>}
              {entities.map((e) => (
                <button
                  key={e.masterId}
                  className="ruled"
                  style={{ padding: "0.5rem 0.7rem", cursor: "pointer", textAlign: "left" }}
                  onClick={() => openEntity(e.masterId)}
                >
                  <span className="prose small"><strong>{e.primaryName}</strong></span>
                  <div className="legend">{e.masterId} · {e.sources.join(", ") || "no source"}</div>
                </button>
              ))}
            </div>
          </aside>

          <div>
            {!selected && <p className="prose small">Select an entity to see its cross-source coverage.</p>}
            {selected && (
              <div className="ruled" style={{ padding: "1.1rem" }}>
                <span className="legend">
                  {selected.entity.primaryName} · {selected.entity.masterId} · {selected.coverage.sourceCount} source
                  {selected.coverage.sourceCount === 1 ? "" : "s"}
                </span>
                <div className="legend mt">
                  {["lei", "chNumber", "cik"].map((k) => selected.entity.identifiers[k as "lei"] ? `${k}:${selected.entity.identifiers[k as "lei"]}` : null).filter(Boolean).join(" · ") || "no external ids"}
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "0.6rem" }}>
                  <thead>
                    <tr className="legend"><td style={{ padding: "0.3rem 0" }}>Metric</td><td>Period</td><td>Sources</td><td>As of</td><td style={{ textAlign: "right" }}>Rung</td></tr>
                  </thead>
                  <tbody>
                    {selected.coverage.items.map((it) => (
                      <tr key={`${it.metric}.${it.period}`} style={{ borderTop: "1px solid var(--rule)" }}>
                        <td className="prose small" style={{ padding: "0.4rem 0" }}>{it.metric}</td>
                        <td className="prose small">{it.period}</td>
                        <td className="legend">{it.sources.join(", ")}</td>
                        <td className="legend">{(it.asOf ?? "").slice(0, 10)}</td>
                        <td className="legend" style={{ textAlign: "right" }}>{RUNG_LABEL[it.rung] ?? it.rung}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {selected.instruments && selected.instruments.length > 0 && (
                  <div className="mt">
                    <span className="legend">Capital structure ({selected.instruments.length} instrument{selected.instruments.length === 1 ? "" : "s"})</span>
                    <ul className="prose small" style={{ paddingLeft: "1.1rem", margin: "0.3rem 0" }}>
                      {selected.instruments.map((ins) => (
                        <li key={`${ins.instrumentId}:${ins.source}`}>{ins.label} <span className="legend">({ins.kind} · {ins.source})</span></li>
                      ))}
                    </ul>
                  </div>
                )}

                {selected.knownUnknowns && (
                  <div className="mt">
                    <span className="legend">
                      Known-unknowns · {selected.knownUnknowns.supportedCount} supported · {selected.knownUnknowns.gapCount} gap
                      {selected.knownUnknowns.gapCount === 1 ? "" : "s"}
                    </span>
                    <ul className="prose small" style={{ paddingLeft: "1.1rem", margin: "0.3rem 0" }}>
                      {selected.knownUnknowns.items.filter((g) => !g.supported).map((g) => (
                        <li key={g.concept}>
                          <strong>{g.concept}</strong> <span className="legend">not held</span>
                          {g.gapReason ? <span className="legend"> - {g.gapReason}</span> : null}
                          {g.closesWith ? <span className="legend"> · closes with: {g.closesWith}</span> : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      <hr className="hairline" />
      <section>
        <span className="legend"><Link href="/" style={{ color: "var(--accent)" }}>← Home</Link></span>
      </section>
    </main>
  );
}
