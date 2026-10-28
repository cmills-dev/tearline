// lib/references/rows.ts
// One row per figure on a sheet, with everything a reader needs to find it in the filing: the
// source document, the page, the figure exactly as printed, the verification tags, the scale the
// printed figure was read under, a link to the filing and the hashes. The HTML pack and its CSV
// twin are both rendered from these rows, so the two cannot disagree.
//
// Nothing here is worked out afresh. Every cell is read off the assembled TearSheet (the same
// object the sheet page renders): the evidence card for the provenance, the export row for the
// stored value, the facilities table for the debt note. Two cells are recovered from text the
// engine itself wrote, because the provenance does not carry them as fields:
//   - the scale multiplier, from the attempt log line "Scale applied: x1000000." that
//     lib/sources/companiesHouseLive.ts writes on every scan-read figure;
//   - the printed scale caption, from the double-read check's detail "... both under £m, ...".
// A figure whose log does not carry them gets empty cells, never a guess.

import type { TearSheet, ExportRow } from "../engine/assemble";
import type { EvidenceCard, FacilityCellKey, Rung } from "../engine/types";
import { FACILITY_CELL_KEYS } from "../engine/types";
import { contentHash } from "../engine/hash";

export type ReferenceRowKind = "figure" | "facility";

export interface ReferenceRow {
  ref: string; // F1, F2 ... for figures, D1, D2 ... for debt-note cells, stable for one sheet
  kind: ReferenceRowKind;
  figureId: string; // fact id, or facility row id and cell key
  label: string;
  period: string;
  value: string; // the stored value, as the engine holds it (units of `unit`); empty at R4
  display: string; // the value as the sheet shows it
  unit: string;
  rung: Rung | "";
  rungLabel: string;
  verificationStatus: string;
  tags: string[]; // scan-read tags, then every check that ran and passed
  sourceTag: string; // Acc, Web, NF, Reg
  sourceDocument: string;
  locator: string;
  page: number | null; // 1-based PDF page, scan reads and debt-note cells only
  printedText: string; // the figure exactly as printed on that page
  scaleCaption: string; // the unit caption it was printed under, e.g. "£m"
  scaleMultiplier: number | null; // what the printed figure was multiplied by to reach `value`
  basis: string; // whose figure this is (WP-BE19), the sentence every surface prints
  link: string; // an http(s) link to the filing, at the page where one is known; else empty
  retrievedAt: string;
  sourceHash: string; // hash of the cited passage, computed at ingest
  cardHash: string; // hash of the evidence card, computed at assemble time (the sheet's hash)
  citation: string; // the snippet or citation the engine recorded
  derivation: string; // R2: the formula; R3: what stood in and which way it errs
  abstainReason: string; // R4: the last attempt's detail
}

const CH_PUBLIC = "https://find-and-update.company-information.service.gov.uk/company";

// A Companies House transaction id is URL-safe base64. Anything else is not put in a link.
const TX_ID = /^[A-Za-z0-9_-]{8,64}$/;
const CH_NUMBER = /^[A-Z0-9]{8}$/;

function transactionFrom(basisFiling: string | undefined): string | null {
  const m = basisFiling?.match(/transaction ([A-Za-z0-9_-]+)/);
  return m && TX_ID.test(m[1]) ? m[1] : null;
}

function isHttp(s: string): boolean {
  return /^https?:\/\/[^\s"'<>]+$/i.test(s);
}

// The filing's own document on Companies House, opened at the page the figure is on. The
// public viewer serves the PDF, and a PDF viewer honours #page=N. Built only from a company
// number and a transaction id that both pass their shape checks; otherwise the locator is used
// if it is a link, and the cell is empty if not.
export function filingLink(opts: {
  companyNumber: string | null | undefined;
  transactionId: string | null | undefined;
  page: number | null | undefined;
  locator: string | null | undefined;
}): string {
  const n = (opts.companyNumber ?? "").toUpperCase();
  const tx = opts.transactionId ?? "";
  if (CH_NUMBER.test(n) && TX_ID.test(tx)) {
    const anchor = opts.page && Number.isInteger(opts.page) && opts.page >= 1 ? `#page=${opts.page}` : "";
    return `${CH_PUBLIC}/${n}/filing-history/${tx}/document?format=pdf&download=0${anchor}`;
  }
  const loc = (opts.locator ?? "").trim();
  return isHttp(loc) ? loc : "";
}

function scaleOf(card: EvidenceCard): { caption: string; multiplier: number | null } {
  let multiplier: number | null = null;
  for (const a of card.attemptLog ?? []) {
    const m = a.detail.match(/Scale applied: x(\d+(?:\.\d+)?)/);
    if (m) multiplier = Number(m[1]);
  }
  let caption = "";
  const dr = card.verification.checks.find((c) => c.id.startsWith("double-read."));
  const cm = dr?.detail.match(/both under (.+?), column /);
  if (cm) caption = cm[1];
  return { caption, multiplier };
}

function tagsOf(card: EvidenceCard): string[] {
  const out: string[] = [...(card.provenance?.tags ?? [])];
  for (const c of card.verification.checks) {
    // The double-read check is the double-read tag said again; list it once.
    if (c.id.startsWith("double-read.") && out.includes("double-read")) continue;
    if (c.passed && !out.includes(c.label)) out.push(c.label);
  }
  return out;
}

function derivationOf(card: EvidenceCard): string {
  if (card.proxy) {
    return `${card.proxy.suppliedAs} stands in for ${card.proxy.requested} (${card.proxy.biasDirection}): ${card.proxy.biasNote}`;
  }
  return card.derivation?.formula ?? "";
}

function abstainOf(card: EvidenceCard): string {
  if (card.rung !== "R4") return "";
  const log = card.attemptLog ?? [];
  return log.length ? log[log.length - 1].detail : "No attempt log was recorded.";
}

// Rows in a stable order: the order the sheet's own CSV uses (fact id), then the debt note in
// the order the note prints it.
export function referenceRows(ts: TearSheet): ReferenceRow[] {
  const byCardHash = new Map<string, ExportRow>();
  for (const r of ts.exportRows) if (r.contentHash) byCardHash.set(r.contentHash, r);

  const cards = Object.values(ts.evidence).sort((a, b) => (a.factId < b.factId ? -1 : a.factId > b.factId ? 1 : 0));
  const rows: ReferenceRow[] = [];

  cards.forEach((card, i) => {
    const p = card.provenance;
    const exp = byCardHash.get(card.contentHash);
    const { caption, multiplier } = scaleOf(card);
    // Only a figure read from the accounts is linked to the accounts document. A register fact's
    // basis sentence names the same filing, but the figure is on the register, so it keeps the
    // register link its locator carries.
    const tx = p?.tag === "Acc" ? transactionFrom(p.basis?.filing) : null;
    rows.push({
      ref: `F${i + 1}`,
      kind: "figure",
      figureId: card.factId,
      label: card.metricLabel,
      period: card.period,
      value: exp?.value ?? "",
      // An abstention is said in words. formatValue renders a null as a dash, which reads as
      // nil in a references table and is not house style.
      display: card.rung === "R4" ? "abstained" : card.displayValue,
      unit: exp?.unit ?? "",
      rung: card.rung,
      rungLabel: card.rungLabel,
      verificationStatus: card.verification.status,
      tags: tagsOf(card),
      sourceTag: p?.tag ?? "",
      sourceDocument: p?.documentName ?? "",
      locator: p?.locator ?? "",
      page: p?.page ?? null,
      printedText: p?.printedText ?? "",
      scaleCaption: caption,
      scaleMultiplier: multiplier,
      basis: p?.basis?.text ?? "",
      link: p
        ? filingLink({
            companyNumber: p.basis?.entity.number ?? ts.entity.companyNumber,
            transactionId: tx,
            page: p.page ?? null,
            locator: p.locator,
          })
        : "",
      retrievedAt: p?.retrievedAt ?? "",
      sourceHash: p?.contentHash ?? "",
      cardHash: card.contentHash,
      citation: p?.snippet ?? "",
      derivation: derivationOf(card),
      abstainReason: abstainOf(card),
    });
  });

  rows.push(...facilityRows(ts));
  return rows;
}

// The debt-note facilities table (WP-BE16): one row per cell both reads agreed on. Cells the
// note does not print, and cells that abstain, are left out here and counted in the pack's
// coverage lines instead, because they are not figures on the sheet.
function facilityRows(ts: TearSheet): ReferenceRow[] {
  const cs = ts.facilities;
  if (!cs || cs.status !== "found") return [];
  const out: ReferenceRow[] = [];
  const basis = cs.basis;
  let n = 0;
  for (const row of cs.rows) {
    if (row.status !== "found") continue;
    for (const key of FACILITY_CELL_KEYS as readonly FacilityCellKey[]) {
      const cell = row.cells[key];
      if (cell.status !== "agreed" || !cell.text) continue;
      n++;
      const page = cell.page ?? row.page;
      const isAmount = cell.pounds !== null;
      out.push({
        ref: `D${n}`,
        kind: "facility",
        figureId: `${row.id}.${key}`,
        label: `${row.name ?? "Facility"}: ${key}`,
        period: "",
        value: isAmount ? String(cell.pounds) : "",
        display: cell.text,
        unit: isAmount ? "GBP" : "",
        rung: "",
        rungLabel: "",
        verificationStatus: "double-read agreed",
        tags: ["double-read"],
        sourceTag: "Acc",
        sourceDocument: cs.noteHeading ? `Debt note: ${cs.noteHeading}` : "Debt note",
        locator: row.citation,
        page,
        printedText: cell.text,
        scaleCaption: isAmount ? cs.scaleCaption ?? "" : "",
        scaleMultiplier: null,
        basis: basis?.text ?? "",
        link: filingLink({
          companyNumber: basis?.entity.number ?? ts.entity.companyNumber,
          transactionId: cs.transactionId,
          page,
          locator: null,
        }),
        retrievedAt: "",
        // The table carries no per-cell hash, so this one is computed here, over exactly what the
        // row shows. It is marked as the pack's own in the pack's legend.
        sourceHash: contentHash([cs.transactionId, row.id, key, page ?? "", cell.text].join("|")),
        cardHash: "",
        citation: row.citation,
        derivation: "",
        abstainReason: "",
      });
    }
  }
  return out;
}

export const REFERENCE_CSV_HEADER = [
  "ref",
  "kind",
  "figure_id",
  "label",
  "period",
  "value",
  "display",
  "unit",
  "rung",
  "verification_status",
  "verification_tags",
  "source_tag",
  "source_document",
  "locator",
  "page",
  "printed_text",
  "scale_caption",
  "scale_multiplier",
  "basis",
  "link",
  "retrieved_at",
  "source_hash",
  "card_hash",
  "citation",
  "derivation",
  "abstain_reason",
] as const;

export function csvRecord(r: ReferenceRow): (string | number | null)[] {
  return [
    r.ref,
    r.kind,
    r.figureId,
    r.label,
    r.period,
    r.value,
    r.display,
    r.unit,
    r.rung,
    r.verificationStatus,
    r.tags.join(" | "),
    r.sourceTag,
    r.sourceDocument,
    r.locator,
    r.page,
    r.printedText,
    r.scaleCaption,
    r.scaleMultiplier,
    r.basis,
    r.link,
    r.retrievedAt,
    r.sourceHash,
    r.cardHash,
    r.citation,
    r.derivation,
    r.abstainReason,
  ];
}
