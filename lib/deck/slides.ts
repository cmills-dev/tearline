// lib/deck/slides.ts
// The deck model (WP-BE09): six slides built from a saved run's tear sheet, in the order the
// backlog names them: title, snapshot, financials, capital structure with facilities, catalysts,
// sources and disclaimer.
//
// The one rule: the deck computes no figure. Every number on a slide is a display string the
// sheet already carries (a tile, a financials cell, a delta, a capital row, a facility cell as the
// note printed it). test/deck.test.ts checks that every figure on the rendered deck is one of the
// sheet's own display strings. An abstained figure is shown as "abstained" with its reason, never
// as a blank or a zero.

import type { TearSheet } from "../engine/assemble";
import type { CapitalStructure, FacilityCellKey, Rung } from "../engine/types";
import { RUNG_META } from "../engine/types";
import type { Signal } from "../originate/signals";

export interface Figure {
  label: string;
  display: string; // exactly as on the sheet
  rung: Rung | null;
  stamp?: boolean; // the one figure that matters (the sheet's fulcrum figure)
  note?: string;
}

export interface TitleSlide { kind: "title"; company: string; companyNumber: string; synthetic: boolean; thesis: string; period: string; generatedOn: string }
export interface SnapshotSlide { kind: "snapshot"; tiles: Figure[]; facts: { label: string; value: string }[]; ladder: { rung: Rung; label: string; count: number }[] }
export interface FinancialsSlide { kind: "financials"; periods: string[]; rows: { label: string; cells: Figure[]; delta: string; deltaNote?: string }[]; hiddenRows: number }
export interface CapitalSlide {
  kind: "capital";
  rows: { name: string; rank: string; provider: string; security: string; amount: Figure }[];
  facilities: { status: "found" | "abstain" | "none"; reason: string | null; caption: string | null; pages: number[]; rows: { name: string; page: string; cells: Record<FacilityCellKey, string> }[]; hiddenRows: number };
}
export interface CatalystsSlide { kind: "catalysts"; items: { label: string; detail: string; direction: Signal["direction"]; cite: string }[]; narrative: string[] }
export interface SourcesSlide { kind: "sources"; references: { n: number; document: string; locator: string; backs: number }[]; hiddenRefs: number; verification: { passed: number; failed: number } }

export type Slide = TitleSlide | SnapshotSlide | FinancialsSlide | CapitalSlide | CatalystsSlide | SourcesSlide;

export interface Deck {
  title: string;
  filenameBase: string;
  sheetKey: string;
  runId?: string;
  slides: Slide[];
}

export interface DeckOptions {
  sheetKey: string;
  runId?: string;
  generatedAt: string; // ISO
  signals?: Signal[]; // from lib/originate/signals.ts detectSignals, when the manifest is at hand
}

// A slide holds what fits on one 16:9 page at a legible size. What does not fit is counted and
// named on the slide ("4 more rows on the sheet"), never silently dropped.
export const LIMITS = { financialRows: 12, facilityRows: 6, capitalRows: 6, references: 14, catalysts: 6, narrative: 4 };

const FACILITY_COLS: FacilityCellKey[] = ["drawn", "committed", "maturity", "rateOrMargin", "security"];

function slug(s: string): string {
  return s.toLowerCase().replace(/\(illustrative\)/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "sheet";
}

function longDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" });
}

function facilityCell(cs: CapitalStructure["rows"][number]["cells"][FacilityCellKey]): string {
  if (cs.status === "agreed") return cs.text ?? "";
  if (cs.status === "not-printed") return "not printed";
  return "abstained";
}

export function buildDeck(ts: TearSheet, opts: DeckOptions): Deck {
  const company = ts.entity.companyName;
  const title: TitleSlide = {
    kind: "title",
    company,
    companyNumber: ts.entity.companyNumber,
    synthetic: ts.entity.synthetic,
    thesis: ts.thesis,
    period: ts.primaryPeriod,
    generatedOn: longDate(opts.generatedAt),
  };

  const snapshot: SnapshotSlide = {
    kind: "snapshot",
    tiles: ts.tiles.map((t) => ({ label: t.label, display: t.display, rung: t.rung, stamp: t.isFulcrumFigure === true })),
    facts: [
      { label: "Company number", value: ts.entity.companyNumber },
      { label: "Status", value: ts.entity.status },
      { label: "Accounts type", value: String(ts.entity.accountsType) },
      { label: "Latest period end", value: ts.entity.latestPeriodEnd },
      { label: "SIC codes", value: ts.entity.sicCodes.join(", ") || "none filed" },
    ],
    ladder: (Object.keys(ts.ladder.counts) as Rung[]).map((r) => ({ rung: r, label: RUNG_META[r].label, count: ts.ladder.counts[r] })),
  };

  const rows = ts.financials.rows;
  const financials: FinancialsSlide = {
    kind: "financials",
    periods: ts.financials.periodLabels,
    rows: rows.slice(0, LIMITS.financialRows).map((r) => ({
      label: r.label,
      cells: r.cells.map((c) => ({ label: r.label, display: c.display, rung: c.rung, stamp: false })),
      delta: r.delta.status === "computed" ? `${r.delta.absDisplay} (${r.delta.pctDisplay})` : r.delta.status === "abstain" ? "abstained" : "",
      deltaNote: r.delta.note,
    })),
    hiddenRows: Math.max(0, rows.length - LIMITS.financialRows),
  };

  const fac = ts.facilities;
  const capital: CapitalSlide = {
    kind: "capital",
    rows: ts.capital.slice(0, LIMITS.capitalRows).map((c) => ({
      name: c.name,
      rank: c.rank,
      provider: c.provider,
      security: c.security,
      amount: { label: c.name, display: c.display, rung: c.rung, stamp: c.isFulcrum },
    })),
    facilities: !fac
      ? { status: "none", reason: "No scanned debt note was read for this sheet.", caption: null, pages: [], rows: [], hiddenRows: 0 }
      : {
          status: fac.status,
          reason: fac.reason,
          caption: fac.scaleCaption,
          pages: fac.pages,
          rows: fac.rows.slice(0, LIMITS.facilityRows).map((r) => ({
            name: r.status === "abstain" ? `abstained: ${r.reason ?? "no reason recorded"}` : r.name ?? "unnamed facility",
            page: r.page === null ? "" : `p.${r.page}`,
            cells: Object.fromEntries(FACILITY_COLS.map((k) => [k, r.status === "abstain" ? "" : facilityCell(r.cells[k])])) as Record<FacilityCellKey, string>,
          })),
          hiddenRows: Math.max(0, fac.rows.length - LIMITS.facilityRows),
        },
  };

  const cited = (opts.signals ?? []).filter((s) => s.source !== null);
  const catalysts: CatalystsSlide = {
    kind: "catalysts",
    items: cited.slice(0, LIMITS.catalysts).map((s) => ({
      label: s.label,
      detail: s.caveat ? `${s.detail} ${s.caveat}` : s.detail,
      direction: s.direction,
      cite: `${s.source!.documentName}${s.source!.locator ? `, ${s.source!.locator}` : ""}`,
    })),
    narrative: ts.narrative.slice(0, LIMITS.narrative),
  };

  const sources: SourcesSlide = {
    kind: "sources",
    references: ts.references.slice(0, LIMITS.references).map((r) => ({ n: r.citation, document: r.documentName, locator: r.locator, backs: r.backs.length })),
    hiddenRefs: Math.max(0, ts.references.length - LIMITS.references),
    verification: { passed: ts.verification.passed, failed: ts.verification.failed },
  };

  const date = opts.generatedAt.slice(0, 10);
  return {
    title: `${company}: credit tear sheet`,
    filenameBase: `${slug(company)}-deck-${date}`,
    sheetKey: opts.sheetKey,
    runId: opts.runId,
    slides: [title, snapshot, financials, capital, catalysts, sources],
  };
}

// Every figure the deck prints, for the test that ties the deck to the sheet.
export function deckFigures(deck: Deck): string[] {
  const out: string[] = [];
  for (const s of deck.slides) {
    if (s.kind === "snapshot") out.push(...s.tiles.map((t) => t.display));
    if (s.kind === "financials") for (const r of s.rows) out.push(...r.cells.map((c) => c.display), ...(r.delta && r.delta !== "abstained" ? [r.delta] : []));
    if (s.kind === "capital") {
      out.push(...s.rows.map((r) => r.amount.display));
      for (const r of s.facilities.rows) out.push(...Object.values(r.cells).filter((v) => v && v !== "not printed" && v !== "abstained"));
    }
  }
  return out;
}
