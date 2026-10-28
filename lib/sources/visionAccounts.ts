// lib/sources/visionAccounts.ts
// A vision read of a scanned Companies House filing, turned into the engine's financial lines.
//
// The reader transcribes; this module maps. It applies the printed scale caption, gives each
// base line the engine's metric name, and writes the citation a scan can actually support:
// the PDF page, the printed label, the figure exactly as printed, the scale caption, the
// statement, the period and the verification tag. There is no quotable text layer on a scan
// (audit finding 19), so "page and printed text" IS the citation.
//
// Nothing here computes a figure. Where the balance sheet prints borrowings split by maturity,
// the two printed lines are landed separately and the ladder adds them at R2 with a declared
// formula (lib/engine/ladder.ts borrowingsResolver), so the arithmetic is on the record.

import { scaleFromCaption, toPence } from "../vision/scale";
import { doubleReadProblem, type JudgeOptions } from "../vision/verify";
import { ABSTAIN, type BaseLineKey, type FoundLine, type VerifiedLine, type VisionReadResult } from "../vision/types";
import type { FactPrecision, ScanReadTag } from "../engine/types";
import { precisionFromPrinted } from "../engine/precision";

// How a printed figure becomes the engine's number.
//   signed     the printed sign is the meaning. A loss, or a net liabilities position, is
//              negative and must stay negative.
//   liability  the line is a balance owed. UK balance sheets print creditors in brackets as a
//              presentation convention, so the magnitude is the balance and the brackets are
//              not a negative liability. The printed text keeps the brackets in the citation.
//   cost       the line is a charge for the period. The ladder adds D&A back to operating
//              profit and divides EBITDA by interest expense, so both are magnitudes. Again the
//              printed text keeps whatever sign was on the page.
type Nature = "signed" | "liability" | "cost";

interface Mapping {
  metric: string;
  label: string;
  nature: Nature;
}

export const VISION_METRICS: Record<BaseLineKey, Mapping> = {
  turnover: { metric: "turnover", label: "Turnover", nature: "signed" },
  operating_profit: { metric: "operatingProfit", label: "Operating profit", nature: "signed" },
  depreciation_amortisation: {
    metric: "depreciationAmortisation",
    label: "Depreciation and amortisation",
    nature: "cost",
  },
  interest_payable: { metric: "netInterest", label: "Interest expense", nature: "cost" },
  profit_before_tax: { metric: "profitBeforeTax", label: "Profit before tax", nature: "signed" },
  cash_at_bank: { metric: "cash", label: "Cash and cash equivalents", nature: "signed" },
  borrowings_within_one_year: {
    metric: "borrowingsWithinOneYear",
    label: "Borrowings falling due within one year",
    nature: "liability",
  },
  borrowings_after_one_year: {
    metric: "borrowingsAfterOneYear",
    label: "Borrowings falling due after more than one year",
    nature: "liability",
  },
  lease_liabilities_total: { metric: "leaseLiabilitiesTotal", label: "Lease liabilities (total)", nature: "liability" },
  lease_liabilities_current: {
    metric: "leaseLiabilitiesCurrent",
    label: "Lease liabilities due within one year",
    nature: "liability",
  },
  lease_liabilities_non_current: {
    metric: "leaseLiabilitiesNonCurrent",
    label: "Lease liabilities due after more than one year",
    nature: "liability",
  },
  preference_shares: { metric: "preferenceShares", label: "Preference shares", nature: "liability" },
  shareholder_loans: { metric: "shareholderLoans", label: "Shareholder and parent loans", nature: "liability" },
  net_assets: { metric: "netAssets", label: "Net assets", nature: "signed" },
  total_assets: { metric: "totalAssets", label: "Total assets", nature: "signed" },
  current_liabilities: {
    metric: "currentLiabilities",
    label: "Creditors falling due within one year",
    nature: "liability",
  },
  net_current_liabilities: {
    metric: "netCurrentLiabilities",
    label: "Net current assets / (liabilities)",
    nature: "signed",
  },
};

export interface VisionFigure {
  key: BaseLineKey;
  metric: string;
  label: string; // the printed label when the reader gave one, else the metric's plain label
  value: number; // pounds, the printed scale applied
  unit: string; // "GBP"
  periodEnd: string; // YYYY-MM-DD, the period the figure was read from
  scale: number;
  citation: string; // page, printed text, scale, statement, period and the verification tag
  line: FoundLine;
  tag: VerifiedLine;
  precision?: FactPrecision; // the printed figure's last digit under its scale, for the structural checks
  tags: ScanReadTag[]; // always "double-read"; "tie-pass" when a printed tie ran and held; "period-from-header-row" when the period came from a header row (WP-BE22)
}

export interface VisionAbstention {
  key: BaseLineKey;
  metric: string;
  label: string;
  reason: string;
}

export interface VisionLines {
  figures: VisionFigure[];
  abstentions: VisionAbstention[];
  periodEnd: string | null;
  basis: "consolidated" | "company" | null;
}

// "Net assets" is what the engine calls the line; "Net liabilities" is what the page says when
// it is negative. The printed label wins, so a net liabilities position is never relabelled.
function labelFor(line: FoundLine, mapping: Mapping): string {
  return line.printedLabel ?? mapping.label;
}

// The provenance tags a landed figure carries. Only called once doubleReadProblem has passed.
export function scanReadTags(tag: VerifiedLine): ScanReadTag[] {
  const tags: ScanReadTag[] = ["double-read"];
  if (tag.evidence?.ties.some((t) => t.status === "pass")) tags.push("tie-pass");
  if (tag.evidence?.second.periodSource?.from === "header-row") tags.push("period-from-header-row");
  return tags;
}

export function citationFor(line: FoundLine, tag: VerifiedLine): string {
  const parts: string[] = [];
  const printedPage = line.printedPageNumber ? ` (printed page ${line.printedPageNumber})` : "";
  parts.push(`PDF page ${line.pdfPageIndex}${printedPage}`);
  const label = line.printedLabel ? `"${line.printedLabel}" ` : "";
  parts.push(`${label}printed as "${line.figureText}" under ${line.scaleCaption}`);
  parts.push(line.statement);
  parts.push(`period ended ${line.periodEnd}`);
  if (line.noteReference) parts.push(`note ${line.noteReference}`);
  const note = tag.note ? ` ${tag.note}` : "";
  const checked = tag.tag === "verified" ? scanReadTags(tag).join(", ") : tag.tag;
  return `${parts.join(", ")}. Checked: ${checked}.${note}`;
}

// Apply the nature rule, and round to the penny so a scaled decimal such as 8.3 under £m is
// 8,300,000 rather than 8,300,000.000000001.
function engineValue(printed: number, nature: Nature): number {
  return toPence(nature === "signed" ? printed : Math.abs(printed));
}

// A read, with its verification tags, as engine-ready lines. Every base line comes back once,
// either as a figure or as a named abstention, so a sheet can always say why a line is missing.
export function visionLines(
  read: VisionReadResult,
  tags: Record<BaseLineKey, VerifiedLine>,
  fallbackPeriodEnd: string | null,
  options: JudgeOptions = {},
): VisionLines {
  const figures: VisionFigure[] = [];
  const abstentions: VisionAbstention[] = [];

  for (const [key, mapping] of Object.entries(VISION_METRICS) as [BaseLineKey, Mapping][]) {
    const line = read.lines[key];
    const tag = tags[key] ?? { tag: "unverified" as const, note: null };
    if (!line || line.status === "abstain") {
      abstentions.push({ key, metric: mapping.metric, label: mapping.label, reason: line?.reason ?? ABSTAIN.notReturned });
      continue;
    }
    const scale = scaleFromCaption(line.scaleCaption);
    if (scale === null) {
      // The caption was printed but this code does not understand it. Landing the figure at
      // face value is the 1,000x error, so the line abstains and names the caption.
      abstentions.push({
        key,
        metric: mapping.metric,
        label: mapping.label,
        reason: `${ABSTAIN.noScale}: ${line.scaleCaption}`,
      });
      continue;
    }
    // The rung and citation rule (WP-BE05): a scanned figure lands only on a double read that
    // agrees with it. This runs whatever verifier ran, so no verifier, and no flag, can put a
    // single read on the sheet.
    const problem = doubleReadProblem(line, tag, { ...options, read });
    if (problem) {
      abstentions.push({ key, metric: mapping.metric, label: mapping.label, reason: problem });
      continue;
    }
    figures.push({
      key,
      metric: mapping.metric,
      label: labelFor(line, mapping),
      value: engineValue(line.value * scale, mapping.nature),
      unit: "GBP",
      periodEnd: line.periodEnd || fallbackPeriodEnd || "",
      scale,
      citation: citationFor(line, tag),
      line,
      tag,
      tags: scanReadTags(tag),
      precision: precisionFromPrinted(line.figureText, scale),
    });
  }

  return {
    figures,
    abstentions,
    periodEnd: read.document.periodEnd ?? fallbackPeriodEnd,
    basis: read.document.basis,
  };
}
