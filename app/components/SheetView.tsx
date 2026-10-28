"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import type { DeltaCell, TearSheet } from "@/lib/engine/assemble";
import { toCsv } from "@/lib/engine/assemble";
import type { EvidenceCard, Rung } from "@/lib/engine/types";
import { RUNG_META } from "@/lib/engine/types";
import { BLANK } from "@/lib/format/format";

function RungBadge({ rung }: { rung: Rung }) {
  return (
    <span className={`rung ${rung}`} title={RUNG_META[rung].blurb}>
      {rung} {RUNG_META[rung].label}
    </span>
  );
}

const DIRECTION_GLYPH: Record<DeltaCell["direction"], string> = {
  up: "▲",
  down: "▼",
  flat: "▬",
  none: "",
};

function DeltaView({ delta }: { delta: DeltaCell }) {
  if (delta.status !== "computed") {
    return (
      <span className="delta muted" title={delta.note ?? ""}>
        {BLANK} <span className="small">{delta.status === "abstain" ? "abstain" : "single period"}</span>
      </span>
    );
  }
  return (
    <span className={`delta ${delta.direction} ${delta.isFulcrum ? "fulcrum" : ""}`}>
      <span className="arrow" aria-hidden="true">
        {DIRECTION_GLYPH[delta.direction]}
      </span>
      {delta.absDisplay}
      <span className="pct">{delta.pctDisplay}</span>
    </span>
  );
}

// Client-side CSV export of the fact manifest. No server needed: build a Blob and
// click a temporary link. Every row traces back to a real fact (abstains included).
function downloadManifestCsv(ts: TearSheet) {
  const csv = toCsv(ts.exportRows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = ts.exportFilename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const STATUS_LABEL: Record<string, string> = {
  STRUCTURAL_PASS: "Structural pass",
  STRUCTURAL_FAIL: "Structural fail",
  SINGLE_SOURCE: "Single source",
  DERIVED: "Derived, consistent",
  NOT_APPLICABLE: "Not applicable",
};

export default function SheetView({ ts }: { ts: TearSheet }) {
  const [selected, setSelected] = useState<string | null>(null);
  const card: EvidenceCard | null = selected ? ts.evidence[selected] ?? null : null;

  // The Excel model is served by /api/model/<key>, which resolves a fixture key. Derive
  // that key from the /sheet/<key> route; on other routes (e.g. the live path, where no
  // fixture key exists) the link is hidden rather than pointing at a dead endpoint.
  const pathname = usePathname();
  const modelKeyMatch = pathname?.match(/^\/sheet\/([^/]+)/);
  const modelKey = modelKeyMatch ? decodeURIComponent(modelKeyMatch[1]) : null;

  const open = (id: string | null) => setSelected(id);

  return (
    <main className="frame doc">
      {/* Cover / tombstone */}
      <section style={{ paddingTop: "2.2rem" }}>
        <span className="legend">Confidential tear sheet · assembled from a fact manifest</span>
        <h1 style={{ marginTop: "0.5rem" }}>{ts.entity.companyName}</h1>
        <p className="legend mt">
          Company no. {ts.entity.companyNumber} · {ts.entity.jurisdiction} · status {ts.entity.status} ·{" "}
          {ts.entity.accountsType} accounts · registered {ts.entity.registeredOffice}
        </p>
        <p className="prose small mt muted">{ts.thesis}</p>
      </section>

      {/* Ladder summary */}
      <section className="mt">
        <span className="legend">Resolution ladder across {ts.ladder.total} facts</span>
        <div className="ladder-bar mt">
          {(["R1", "R2", "R3", "R4"] as Rung[]).map((r) => (
            <div className="ladder-seg" key={r}>
              <span className="n">{ts.ladder.counts[r]}</span>
              <RungBadge rung={r} />
            </div>
          ))}
        </div>
      </section>

      {/* Key figures */}
      <section className="mt">
        <span className="legend">Key figures · {ts.primaryPeriod}</span>
        <div className="tiles mt">
          {ts.tiles.map((t) => (
            <button
              key={t.factId}
              className={`tile ${t.isFulcrumFigure ? "fulcrum" : ""}`}
              onClick={() => open(t.factId)}
            >
              <span className="legend">{t.label}</span>
              <span className="figure num">{t.display}</span>
              <RungBadge rung={t.rung} />
            </button>
          ))}
        </div>
        <p className="legend mt">Click any figure to open its evidence card.</p>
      </section>

      {/* Narrative (ProseGate-clean, language plane) */}
      <section>
        <h2>Position</h2>
        <div className="prose">
          {ts.narrative.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
        <p className="legend">
          Generated deterministically by the language plane. Every figure above is a fact reference; ProseGate
          cleared the copy before it shipped.
        </p>
      </section>

      {/* Financials table */}
      <section>
        <div className="section-head">
          <h2>Financials</h2>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button className="export-btn" onClick={() => downloadManifestCsv(ts)}>
              Download data · CSV
            </button>
            {modelKey && (
              <a className="export-btn" href={`/api/model/${modelKey}`}>
                Download model · Excel
              </a>
            )}
          </div>
        </div>
        <span className="legend">
          {ts.financials.priorLabel
            ? `Year-on-year change is ${ts.financials.latestLabel} against ${ts.financials.priorLabel}, computed in code and only where both periods resolve. A blank marks an abstain, never a guess.`
            : "Only one period is on file, so no year-on-year change can be computed."}
        </span>
        <div className="table-wrap mt">
          <table className="data">
            <thead>
              <tr>
                <th>Line</th>
                {ts.financials.periodLabels.map((p) => (
                  <th key={p}>{p}</th>
                ))}
                <th>YoY change</th>
                <th>Rung (latest)</th>
              </tr>
            </thead>
            <tbody>
              {ts.financials.rows.map((row) => {
                const latest = row.cells[0];
                return (
                  <tr key={row.metric}>
                    <td>{row.label}</td>
                    {row.cells.map((c, i) => (
                      <td className="num" key={i}>
                        {c.factId ? (
                          <button className="cell-btn" onClick={() => open(c.factId)}>
                            {c.display}
                          </button>
                        ) : (
                          <span className="muted">{c.display}</span>
                        )}
                      </td>
                    ))}
                    <td className="num">
                      <DeltaView delta={row.delta} />
                    </td>
                    <td style={{ textAlign: "left" }}>
                      {latest.rung ? <RungBadge rung={latest.rung} /> : <span className="muted">{BLANK}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Capital structure */}
      <section>
        <h2>Capital structure</h2>
        <span className="legend">Senior to junior · the maroon rule marks the expected fulcrum</span>
        <div className="capital mt">
          {ts.capital.map((c) => (
            <div className={`tranche ${c.isFulcrum ? "fulcrum" : ""}`} key={c.id}>
              <div>
                <div>{c.name}</div>
                <div className="meta">
                  {c.rank} · {c.provider} · {c.security}
                  {c.isFulcrum ? " · fulcrum" : ""}
                </div>
              </div>
              <div className="amount">
                {c.factId ? (
                  <button className="cell-btn" onClick={() => open(c.factId)}>
                    {c.display}
                  </button>
                ) : (
                  c.display
                )}
                {c.rung && (
                  <div>
                    <RungBadge rung={c.rung} />
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Verification */}
      <section>
        <h2>Verification</h2>
        <span className="legend">
          {ts.verification.passed} passed · {ts.verification.failed} failed · cross-field identities only, no
          claim of independent audit
        </span>
        <div className="mt">
          {ts.verification.checks.length === 0 && (
            <p className="prose small muted">
              No cross-field identity was testable from the filed lines. Facts are held at single-source and
              labelled as such, never as verified.
            </p>
          )}
          {ts.verification.checks.map((c) => (
            <div className="check" key={c.id}>
              <span className={`status ${c.passed ? "pass" : "fail"}`}>{c.passed ? "pass" : "fail"}</span>
              <div>
                <div>
                  <strong>{c.label}</strong>: <span className="mono small">{c.identity}</span>
                </div>
                <div className="num small muted">{c.detail}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Sources / references */}
      <section>
        <h2>Sources</h2>
        {/* "Cited" cannot mean "quoted" here. A scanned Companies House filing has no text
            layer, so a figure read off the page image is located by PDF page, printed label,
            printed figure and scale caption, and carries the tag its verifier gave it. */}
        <span className="legend">
          {ts.references.length} distinct cited sources · each hashed at ingest and cross-referenced to the
          figures it backs · a passage is quoted where the document has text, and a scanned page is cited by
          page, printed figure and verification tag
        </span>
        {ts.references.length === 0 ? (
          <p className="prose small muted mt">
            No external passage is cited: every figure on this sheet either abstained or was synthesised from
            inputs listed on their own cards.
          </p>
        ) : (
          <div className="refs mt">
            {ts.references.map((r) => (
              <div className="ref" key={r.citation}>
                <div className="ref-head">
                  <span className="ref-cite">[{r.citation}]</span>
                  <span className="ptag">[{r.tag}]</span>
                  <span className="ref-doc">{r.documentName}</span>
                  <span className="muted small">· {r.locator}</span>
                </div>
                <ul className="ref-backs">
                  {r.backs.map((b) => (
                    <li key={b.factId}>
                      <button className="cell-btn" onClick={() => open(b.factId)}>
                        {b.label} ({b.period})
                      </button>{" "}
                      <RungBadge rung={b.rung} />
                      <span className="hash ref-hash">{b.contentHash}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="tombstone">
        <span className="legend">
          {ts.entity.synthetic ? "Illustrative · synthetic data" : "LIVE · Companies House public record"}
        </span>
        <div className="mono small">
          Assembled {ts.entity.latestPeriodEnd || BLANK} · {ts.sourceCount} source documents · fact-manifest-first
        </div>
      </div>

      {card && <EvidenceDrawer card={card} onClose={() => open(null)} />}
    </main>
  );
}

function EvidenceDrawer({ card, onClose }: { card: EvidenceCard; onClose: () => void }) {
  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Evidence card">
        <button className="close-x" onClick={onClose} aria-label="Close">
          Close ✕
        </button>
        <span className="legend">Evidence card</span>
        <h2 style={{ marginTop: "0.3rem" }}>{card.metricLabel}</h2>
        <p className="legend">{card.period}</p>
        <p className="figure num" style={{ fontSize: "2rem", margin: "0.4rem 0" }}>
          {card.displayValue}
        </p>
        <RungBadge rung={card.rung} />
        <p className="small muted mt">{RUNG_META[card.rung].blurb}</p>

        <hr className="hairline" style={{ margin: "1.2rem 0" }} />

        {card.provenance ? (
          <>
            <span className="legend">Source</span>
            <dl className="mt">
              <dt>Tag</dt>
              <dd>
                <span className="ptag">[{card.provenance.tag}]</span> {card.provenance.documentName}
              </dd>
              <dt>Locator</dt>
              <dd>{card.provenance.locator}</dd>
              <dt>Retrieved</dt>
              <dd>{card.provenance.retrievedAt || BLANK}</dd>
            </dl>
            <p className="legend mt">Rendered snippet from the source</p>
            <div className="snippet mt">{card.provenance.snippet}</div>
          </>
        ) : (
          <p className="small muted">No source: this field abstained (R4). See the attempt log below.</p>
        )}

        {card.derivation && (
          <>
            <span className="legend mt" style={{ display: "block" }}>
              Derivation
            </span>
            <div className="snippet mt">
              {card.derivation.formula}
              {card.derivation.note ? `\n\nNote: ${card.derivation.note}` : ""}
            </div>
          </>
        )}

        {card.proxy && (
          <>
            <span className="legend mt" style={{ display: "block" }}>
              Proxy substitution
            </span>
            <dl className="mt">
              <dt>Requested</dt>
              <dd>{card.proxy.requested}</dd>
              <dt>Supplied as</dt>
              <dd>{card.proxy.suppliedAs}</dd>
              <dt>Bias</dt>
              <dd>
                This {card.proxy.biasDirection} the true figure. {card.proxy.biasNote}
              </dd>
            </dl>
          </>
        )}

        {card.attemptLog && card.attemptLog.length > 0 && (
          <>
            <span className="legend mt" style={{ display: "block" }}>
              Attempt log
            </span>
            <div className="mt">
              {card.attemptLog.map((a, i) => (
                <div className="check" key={i}>
                  <span className={`status ${a.outcome === "found" ? "pass" : "fail"}`}>{a.outcome}</span>
                  <div>
                    <strong>{a.step}</strong>
                    <div className="small muted">{a.detail}</div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <span className="legend mt" style={{ display: "block" }}>
          Verification
        </span>
        <p className="small">
          {STATUS_LABEL[card.verification.status] ?? card.verification.status}
        </p>
        {card.verification.checks.map((c) => (
          <div className="check" key={c.id}>
            <span className={`status ${c.passed ? "pass" : "fail"}`}>{c.passed ? "pass" : "fail"}</span>
            <div>
              <div className="small">
                <strong>{c.label}</strong>
              </div>
              <div className="num small muted">{c.detail}</div>
            </div>
          </div>
        ))}

        <hr className="hairline" style={{ margin: "1.2rem 0" }} />
        <span className="legend">Content hash (computed at assemble time, read here)</span>
        <p className="hash mt">{card.contentHash}</p>
        {card.provenance?.contentHash && (
          <p className="hash">source: {card.provenance.contentHash}</p>
        )}
      </aside>
    </>
  );
}
