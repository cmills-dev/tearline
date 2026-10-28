// lib/references/pack.ts
// The references pack: an HTML document and its CSV twin, listing every figure on a sheet with
// its source, page, printed text, verification tags, scale, a link to the filing and its hashes.
// Both are rendered from the same rows (lib/references/rows.ts), and the HTML prints the hash of
// the CSV, so a reader holding both can confirm they are the same pack.
//
// The HTML is one self-contained file: inline styles, no script, no external font or image, so it
// opens offline, prints to A4 from any browser and cannot phone home. Every string that came from
// a filing or the register is escaped. A link is only ever written for an http(s) URL.

import type { TearSheet } from "../engine/assemble";
import { contentHash } from "../engine/hash";
import { csvRecord, referenceRows, REFERENCE_CSV_HEADER, type ReferenceRow } from "./rows";
import { toCsvText } from "./csv";

// Neutral placeholders, as in lib/model: the brand is not picked yet (WP-BR05). Georgia for
// words, Courier New for figures.
const TOKENS = {
  ink: "#1a1a1a",
  muted: "#6b6b6b",
  hairline: "#dddbd6",
  headerFill: "#f2f1ef",
  accent: "#3d4a5c",
  text: "Georgia, 'Times New Roman', serif",
  figure: "'Courier New', Courier, monospace",
} as const;

export interface ReferencesPack {
  rows: ReferenceRow[];
  csv: string;
  html: string;
  packHash: string; // FNV-1a 64 of the CSV text without its byte order mark
  filenameBase: string;
}

export interface PackOptions {
  sheetKey?: string;
  runId?: string;
  generatedAt?: string; // ISO instant; defaults to now. Tests pass a fixed one.
}

export function escapeHtml(s: string | number | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeHref(url: string): string | null {
  return /^https?:\/\/[^\s"'<>]+$/i.test(url) ? url : null;
}

export function referencesFilenameBase(companyName: string): string {
  const s = companyName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${s || "tear-sheet"}-references`;
}

export function buildReferencesCsv(rows: ReferenceRow[]): string {
  return toCsvText(REFERENCE_CSV_HEADER, rows.map(csvRecord));
}

export function buildReferencesPack(ts: TearSheet, opts: PackOptions = {}): ReferencesPack {
  const rows = referenceRows(ts);
  const csv = buildReferencesCsv(rows);
  const packHash = contentHash(csv.replace(/^﻿/, ""));
  const html = renderHtml(ts, rows, packHash, opts);
  return { rows, csv, html, packHash, filenameBase: referencesFilenameBase(ts.entity.companyName) };
}

// --- HTML -------------------------------------------------------------------

const CSS = `
@page { size: A4; margin: 14mm 12mm; }
* { box-sizing: border-box; }
body { font-family: ${TOKENS.text}; color: ${TOKENS.ink}; margin: 0 auto; max-width: 1180px; padding: 24px; font-size: 12px; line-height: 1.45; }
h1 { font-size: 22px; margin: 0 0 4px; font-weight: normal; }
h2 { font-size: 15px; margin: 28px 0 8px; font-weight: normal; color: ${TOKENS.accent}; border-bottom: 1px solid ${TOKENS.ink}; padding-bottom: 3px; }
p { margin: 4px 0 8px; }
.muted { color: ${TOKENS.muted}; }
.fig, code { font-family: ${TOKENS.figure}; }
table { border-collapse: collapse; width: 100%; }
th { text-align: left; font-weight: bold; background: ${TOKENS.headerFill}; border-bottom: 1px solid ${TOKENS.ink}; padding: 5px 6px; vertical-align: bottom; }
td { border-bottom: 1px solid ${TOKENS.hairline}; padding: 5px 6px; vertical-align: top; }
td.num { text-align: right; white-space: nowrap; }
dl.meta { display: grid; grid-template-columns: 170px 1fr; gap: 2px 12px; margin: 10px 0; }
dl.meta dt { color: ${TOKENS.muted}; }
dl.meta dd { margin: 0; }
.tag { display: inline-block; border: 1px solid ${TOKENS.hairline}; padding: 0 4px; margin: 0 3px 2px 0; font-size: 10px; }
.hash { font-family: ${TOKENS.figure}; font-size: 10px; word-break: break-all; }
a { color: ${TOKENS.accent}; }
thead { display: table-header-group; }
tr { page-break-inside: avoid; }
@media print { body { padding: 0; max-width: none; font-size: 10px; } a { text-decoration: none; } }
`;

function tagSpans(tags: string[]): string {
  return tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("");
}

function sourceCell(r: ReferenceRow): string {
  const parts: string[] = [];
  if (r.sourceDocument) parts.push(`${r.sourceTag ? `[${escapeHtml(r.sourceTag)}] ` : ""}${escapeHtml(r.sourceDocument)}`);
  if (r.page !== null) parts.push(`PDF page ${escapeHtml(r.page)}`);
  if (r.printedText) parts.push(`printed as <span class="fig">${escapeHtml(r.printedText)}</span>`);
  if (r.scaleCaption || r.scaleMultiplier !== null) {
    const cap = r.scaleCaption ? `under ${escapeHtml(r.scaleCaption)}` : "";
    const mul = r.scaleMultiplier !== null ? `x${escapeHtml(r.scaleMultiplier)}` : "";
    parts.push(`scale ${[cap, mul].filter(Boolean).join(", ")}`);
  }
  if (r.locator && !safeHref(r.locator)) parts.push(`<span class="muted">${escapeHtml(r.locator)}</span>`);
  if (r.derivation) parts.push(`<span class="muted">${escapeHtml(r.derivation)}</span>`);
  if (r.abstainReason) parts.push(`<span class="muted">Abstained: ${escapeHtml(r.abstainReason)}</span>`);
  if (r.basis) parts.push(`<span class="muted">${escapeHtml(r.basis)}</span>`);
  const href = safeHref(r.link);
  if (href) parts.push(`<a href="${escapeHtml(href)}" rel="noopener noreferrer">Open the filing${r.page !== null ? ` at page ${escapeHtml(r.page)}` : ""}</a>`);
  if (!parts.length) parts.push(`<span class="muted">No source: nothing was cited for this figure.</span>`);
  return parts.join("<br>");
}

function hashCell(r: ReferenceRow): string {
  const lines: string[] = [];
  if (r.sourceHash) lines.push(`source ${escapeHtml(r.sourceHash)}`);
  if (r.cardHash) lines.push(`card ${escapeHtml(r.cardHash)}`);
  return `<span class="hash">${lines.join("<br>")}</span>`;
}

function figureTable(rows: ReferenceRow[]): string {
  if (!rows.length) return `<p class="muted">None.</p>`;
  const body = rows
    .map(
      (r) => `<tr id="${escapeHtml(r.ref)}">
<td class="fig">${escapeHtml(r.ref)}</td>
<td>${escapeHtml(r.label)}${r.period ? `<br><span class="muted">${escapeHtml(r.period)}</span>` : ""}</td>
<td class="num fig">${escapeHtml(r.display)}</td>
<td>${r.rung ? `${escapeHtml(r.rung)} ${escapeHtml(r.rungLabel)}<br>` : ""}<span class="muted">${escapeHtml(r.verificationStatus)}</span><br>${tagSpans(r.tags)}</td>
<td>${sourceCell(r)}</td>
<td>${hashCell(r)}</td>
</tr>`
    )
    .join("\n");
  return `<table>
<thead><tr><th>Ref</th><th>Figure</th><th>Value</th><th>Rung and checks</th><th>Source, page, printed text, scale</th><th>Hashes</th></tr></thead>
<tbody>
${body}
</tbody>
</table>`;
}

function sourcesSection(ts: TearSheet): string {
  if (!ts.references.length) return `<p class="muted">No cited passages.</p>`;
  const body = ts.references
    .map(
      (ref) => `<tr>
<td class="fig">[${escapeHtml(ref.citation)}]</td>
<td>[${escapeHtml(ref.tag)}] ${escapeHtml(ref.documentName)}<br><span class="muted">${
        safeHref(ref.locator)
          ? `<a href="${escapeHtml(ref.locator)}" rel="noopener noreferrer">${escapeHtml(ref.locator)}</a>`
          : escapeHtml(ref.locator)
      }</span></td>
<td>${ref.backs.map((b) => `${escapeHtml(b.label)} <span class="muted">${escapeHtml(b.period)}, ${escapeHtml(b.rung)}</span>`).join("<br>")}</td>
</tr>`
    )
    .join("\n");
  return `<table>
<thead><tr><th>Cite</th><th>Document and locator</th><th>Figures it backs</th></tr></thead>
<tbody>
${body}
</tbody>
</table>`;
}

function renderHtml(ts: TearSheet, rows: ReferenceRow[], packHash: string, opts: PackOptions): string {
  const e = ts.entity;
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const figures = rows.filter((r) => r.kind === "figure");
  const facilities = rows.filter((r) => r.kind === "facility");
  const held = figures.filter((r) => r.rung !== "R4");
  const abstained = figures.filter((r) => r.rung === "R4");
  const byRung = (["R1", "R2", "R3", "R4"] as const).map((k) => `${k} ${figures.filter((r) => r.rung === k).length}`).join(", ");
  const noSource = held.filter((r) => !r.sourceDocument && !r.derivation);
  const mode = e.synthetic ? "Illustrative, synthetic data" : "Live public record";
  const cs = ts.facilities;
  const facilityLine = !cs
    ? "No debt note was read for this sheet."
    : cs.status === "abstain"
      ? `The debt note was read and its table is not shown: ${cs.reason ?? "no reason recorded"}.`
      : `${facilities.length} agreed cell${facilities.length === 1 ? "" : "s"} from the debt note${cs.noteHeading ? ` (${cs.noteHeading})` : ""}, PDF pages ${cs.pages.join(", ")}.${cs.scaleCaption ? ` Amounts printed under ${cs.scaleCaption}.` : ""}`;

  const meta: [string, string][] = [
    ["Company number", e.companyNumber],
    ["Jurisdiction", e.jurisdiction],
    ["Accounts type", e.accountsType],
    ["Primary period", ts.primaryPeriod],
    ["Mode", mode],
  ];
  if (opts.sheetKey) meta.push(["Sheet key", opts.sheetKey]);
  if (opts.runId) meta.push(["Run id", opts.runId]);
  meta.push(["Generated", generatedAt]);

  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(e.companyName)}: references pack</title>
<style>${CSS}</style>
</head>
<body>
<header>
<p class="muted">References pack</p>
<h1>${escapeHtml(e.companyName)}</h1>
<dl class="meta">
${meta.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("\n")}
<dt>Pack hash</dt><dd class="hash">${escapeHtml(packHash)}</dd>
</dl>
</header>

<h2>Coverage</h2>
<p>${figures.length} figure${figures.length === 1 ? "" : "s"} on the sheet: ${held.length} held, ${abstained.length} abstained (${escapeHtml(byRung)}).</p>
<p>${escapeHtml(facilityLine)}</p>
<p>${noSource.length === 0 ? "Every held figure names its source or its formula." : `${noSource.length} held figure${noSource.length === 1 ? " names" : "s name"} neither a source nor a formula: ${escapeHtml(noSource.map((r) => r.ref).join(", "))}.`}</p>

<h2>Figures</h2>
${figureTable(figures)}

${facilities.length ? `<h2>Debt note facilities</h2>\n${figureTable(facilities)}` : ""}

<h2>Sources</h2>
${sourcesSection(ts)}

<h2>How to check a figure</h2>
<p>Open the filing link, go to the PDF page named, and find the printed text. The printed figure times the scale is the stored value, in the unit shown in the CSV. A figure marked double-read was read twice, independently, and both reads agreed on value, scale and period. A figure marked tie-pass also took part in a printed arithmetic tie that held.</p>
<p>The source hash is a 64-bit FNV-1a hash of the cited passage, computed when the source was read. The card hash is the sheet's own hash of the evidence card and matches the content_hash column of the sheet's CSV download. Debt-note cells carry no ingest hash, so theirs is computed by this pack over transaction, row, cell, page and printed text. The pack hash is the hash of the CSV twin of this document, without its byte order mark.</p>
<p class="muted">Figures come from public filings and registers. This pack records where each one came from. It is not advice.</p>
</body>
</html>
`;
}
