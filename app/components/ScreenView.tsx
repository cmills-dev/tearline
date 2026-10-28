"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  MANDATE_PRESETS,
  SECTORS,
  REGIONS,
  SITUATION_TAGS,
  type MandateSpec,
  type SectorKey,
  type RegionKey,
  type SituationTagKey,
  type SizeMetric,
} from "@/lib/engineB/mandate";
import { screen, type ScreenResult } from "@/lib/engineB/screen";
import { UNIVERSE_STAMP, type UniverseFact } from "@/lib/engineB/universe";
import { formatValue } from "@/lib/format/format";

const SECTOR_KEYS = Object.keys(SECTORS) as SectorKey[];
const REGION_KEYS = Object.keys(REGIONS) as RegionKey[];

function toM(v: number | undefined): string {
  return v === undefined ? "" : String(v / 1_000_000);
}
function fromM(s: string): number | undefined {
  const n = Number(s);
  return s.trim() === "" || Number.isNaN(n) ? undefined : Math.round(n * 1_000_000);
}
function toX(v: number | undefined): string {
  return v === undefined ? "" : String(v);
}
function fromX(s: string): number | undefined {
  const n = Number(s);
  return s.trim() === "" || Number.isNaN(n) ? undefined : n;
}

function factCell(fact: UniverseFact) {
  return (
    <span className="num">
      {formatValue(fact.value, fact.kind, fact.unit)}{" "}
      <span className={`rung ${fact.rung}`}>{fact.rung}</span>
    </span>
  );
}

export default function ScreenView() {
  const [mandate, setMandate] = useState<MandateSpec>(MANDATE_PRESETS[0]);
  const [openKey, setOpenKey] = useState<string | null>(null);

  const output = useMemo(() => screen(mandate), [mandate]);

  function patch(p: Partial<MandateSpec>) {
    setMandate((m) => ({ ...m, id: "custom", name: "Custom mandate", ...p }));
  }
  function toggle<T>(list: T[], v: T): T[] {
    return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  }

  return (
    <main className="frame doc">
      <section style={{ paddingTop: "2.2rem" }}>
        <span className="legend">Origination screen · Engine B · a mandate in, cited names out</span>
        <h1 style={{ marginTop: "0.5rem", maxWidth: "20ch" }}>Screen the universe against a mandate.</h1>
        <p className="prose small mt muted">{UNIVERSE_STAMP}</p>
      </section>

      {/* Preset chooser */}
      <section className="mt">
        <span className="legend">Preset mandates</span>
        <div className="chip-row mt">
          {MANDATE_PRESETS.map((p) => (
            <button
              key={p.id}
              className={`chip ${mandate.id === p.id ? "on" : ""}`}
              onClick={() => setMandate(p)}
            >
              {p.name}
            </button>
          ))}
        </div>
        <p className="prose small mt muted">{mandate.description}</p>
      </section>

      {/* Mandate entry, as document fields */}
      <section className="mt">
        <span className="legend">Mandate</span>
        <div className="mandate-grid mt">
          <div className="ruled pad">
            <span className="legend">Sectors</span>
            <div className="check-list mt">
              {SECTOR_KEYS.map((s) => (
                <label key={s} className="opt">
                  <input
                    type="checkbox"
                    checked={mandate.sectors.includes(s)}
                    onChange={() => patch({ sectors: toggle(mandate.sectors, s) })}
                  />
                  {SECTORS[s]}
                </label>
              ))}
            </div>
            <p className="legend mt">None ticked means any sector passes.</p>
          </div>

          <div className="ruled pad">
            <span className="legend">Geography</span>
            <div className="check-list mt">
              {REGION_KEYS.map((g) => (
                <label key={g} className="opt">
                  <input
                    type="checkbox"
                    checked={mandate.geography.includes(g)}
                    onChange={() => patch({ geography: toggle(mandate.geography, g) })}
                  />
                  {REGIONS[g]}
                </label>
              ))}
            </div>
            <p className="legend mt">None ticked means any geography passes.</p>
          </div>

          <div className="ruled pad">
            <span className="legend">Size band</span>
            <div className="mt">
              <label className="opt">
                Measure{" "}
                <select
                  value={mandate.size.metric}
                  onChange={(e) => patch({ size: { ...mandate.size, metric: e.target.value as SizeMetric } })}
                >
                  <option value="turnover">Turnover</option>
                  <option value="ebitda">EBITDA</option>
                </select>
              </label>
              <div className="pair mt">
                <label className="opt">
                  Min £m
                  <input
                    type="number"
                    value={toM(mandate.size.min)}
                    onChange={(e) => patch({ size: { ...mandate.size, min: fromM(e.target.value) } })}
                  />
                </label>
                <label className="opt">
                  Max £m
                  <input
                    type="number"
                    value={toM(mandate.size.max)}
                    onChange={(e) => patch({ size: { ...mandate.size, max: fromM(e.target.value) } })}
                  />
                </label>
              </div>
            </div>
          </div>

          <div className="ruled pad">
            <span className="legend">Leverage band (net debt / EBITDA)</span>
            <div className="pair mt">
              <label className="opt">
                Min x
                <input
                  type="number"
                  step="0.1"
                  value={toX(mandate.leverage.min)}
                  onChange={(e) => patch({ leverage: { ...mandate.leverage, min: fromX(e.target.value) } })}
                />
              </label>
              <label className="opt">
                Max x
                <input
                  type="number"
                  step="0.1"
                  value={toX(mandate.leverage.max)}
                  onChange={(e) => patch({ leverage: { ...mandate.leverage, max: fromX(e.target.value) } })}
                />
              </label>
            </div>
          </div>

          <div className="ruled pad span-2">
            <span className="legend">Situation tags</span>
            <div className="check-list mt row">
              {SITUATION_TAGS.map((t) => (
                <label key={t} className="opt">
                  <input
                    type="checkbox"
                    checked={mandate.situationTags.includes(t)}
                    onChange={() => patch({ situationTags: toggle(mandate.situationTags, t) as SituationTagKey[] })}
                  />
                  {t}
                </label>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Ranked results */}
      <section>
        <h2>Ranked names</h2>
        <span className="legend">
          {output.ranked.length} names fit · {output.excluded.length} excluded on a hard filter · deterministic score
        </span>
        <div className="table-wrap mt">
          <table className="data">
            <thead>
              <tr>
                <th>#</th>
                <th>Name</th>
                <th>Sector</th>
                <th>Geography</th>
                <th>Turnover</th>
                <th>EBITDA</th>
                <th>Leverage</th>
                <th>Fit</th>
                <th>Situations</th>
              </tr>
            </thead>
            <tbody>
              {output.ranked.map((r, i) => (
                <ResultRows key={r.member.key} r={r} rank={i + 1} open={openKey === r.member.key} onToggle={() => setOpenKey(openKey === r.member.key ? null : r.member.key)} />
              ))}
            </tbody>
          </table>
        </div>
        <p className="legend mt">Click any row to expand its evidence and one-line rationale.</p>
      </section>

      {/* Excluded */}
      {output.excluded.length > 0 && (
        <section>
          <h2>Excluded on a hard filter</h2>
          <span className="legend">Logged honestly, the way the ladder abstains at R4</span>
          <div className="mt">
            {output.excluded.map((r) => (
              <div className="check" key={r.member.key}>
                <span className="status fail">{r.exclusion!.failedFilter}</span>
                <div>
                  <div>
                    <NameLabel display={r.member.displayName} redacted={r.member.redactedName} />
                  </div>
                  <div className="small muted">{r.exclusion!.reason}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="tombstone">
        <span className="legend">Illustrative · synthetic data</span>
        <div className="mono small">
          Engine B origination screen · {output.ranked.length + output.excluded.length} names in the universe · no name is a real entity
        </div>
      </div>
    </main>
  );
}

function ResultRows({ r, rank, open, onToggle }: { r: ScreenResult; rank: number; open: boolean; onToggle: () => void }) {
  const m = r.member;
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: "pointer" }}>
        <td className="num">{rank}</td>
        <td style={{ textAlign: "left" }}>
          <NameLabel display={m.displayName} redacted={m.redactedName} />
        </td>
        <td style={{ textAlign: "left" }}>{m.sectorLabel}</td>
        <td style={{ textAlign: "left" }}>{m.geographyLabel}</td>
        <td>{factCell(m.turnover)}</td>
        <td>{factCell(m.ebitda)}</td>
        <td>{factCell(m.leverage)}</td>
        <td className="num"><strong>{r.score}</strong></td>
        <td style={{ textAlign: "left" }}>
          {m.situationTags.map((t) => (
            <span className="tagchip" key={t.tag}>{t.tag}</span>
          ))}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={9} style={{ textAlign: "left", background: "var(--paper-2)" }}>
            <div className="evidence-panel">
              <p className="prose small" style={{ margin: "0 0 0.8rem" }}>
                <strong>Rationale.</strong> {r.rationale}
              </p>
              <span className="legend">Evidence</span>
              <ul className="reason-list mt">
                {r.reasons.map((reason, i) => (
                  <li key={i} className={`reason ${reason.polarity}`}>
                    <span className="reason-kind">{reason.kind}</span> {reason.text}
                  </li>
                ))}
              </ul>
              {m.sheetKey ? (
                <Link className="legend" style={{ color: "var(--accent)", display: "inline-block", marginTop: "0.8rem" }} href={`/sheet/${m.sheetKey}`}>
                  Open Engine A tear sheet →
                </Link>
              ) : (
                <p className="legend mt">Synthetic-only name. Fact profile shown inline above; no tear sheet is filed.</p>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function NameLabel({ display, redacted }: { display: string; redacted?: boolean }) {
  if (redacted) {
    const cleaned = display.replace(/[▮]+/g, "");
    return (
      <span>
        {cleaned.split("(")[0].trim()} <span className="redact" title="Redacted codename">████</span>{" "}
        <span className="muted small">(illustrative)</span>
      </span>
    );
  }
  return <span>{display}</span>;
}
