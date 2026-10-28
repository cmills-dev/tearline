// lib/deck/html.ts
// Renders the deck as one self-contained HTML document, one 16:9 landscape page per slide
// (13.333 x 7.5 in, PowerPoint's own size). The export button opens it and the browser prints it to
// PDF. No dependency, no web font, no image, no network: Georgia and Courier New, the brand's
// office faces. With autoprint the page carries one inline script, allowed by its hash alone.

import { createHash } from "crypto";
import { DECK_TOKENS as T } from "./tokens";
import type { CapitalSlide, CatalystsSlide, Deck, Figure, FinancialsSlide, SnapshotSlide, SourcesSlide, Slide, TitleSlide } from "./slides";

export const AUTOPRINT_SCRIPT = "window.addEventListener('load',function(){window.print()});";
export const AUTOPRINT_HASH = `sha256-${createHash("sha256").update(AUTOPRINT_SCRIPT).digest("base64")}`;

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const C = T.colour;
const CSS = `
@page { size: 13.333in 7.5in; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; background: ${C["paper-3"]}; color: ${C.ink}; font-family: ${T.font.mono}; font-size: 11pt; }
.slide { width: 13.333in; height: 7.5in; margin: 0.3in auto; background: ${C.paper}; position: relative; overflow: hidden; padding: 0.95in 0.6in 0.7in; page-break-after: always; break-after: page; }
.band { position: absolute; top: 0; left: 0; right: 0; height: 0.55in; background: ${C.cover}; color: ${C["on-cover"]}; display: flex; align-items: center; justify-content: space-between; padding: 0 0.6in; font-size: 8.5pt; letter-spacing: .08em; text-transform: uppercase; font-weight: 700; }
.band .brand { font-family: ${T.font.serif}; font-size: 13pt; letter-spacing: 0; text-transform: none; font-weight: 400; }
.foot { position: absolute; left: 0.6in; right: 0.6in; bottom: 0.28in; display: flex; justify-content: space-between; font-size: 7.5pt; color: ${C["ink-faint"]}; border-top: 1px solid ${C.rule}; padding-top: 6px; }
h1 { font-family: ${T.font.serif}; font-weight: 400; font-size: 34pt; line-height: 1.1; margin: 0.6in 0 0.2in; }
h2 { font-family: ${T.font.serif}; font-weight: 400; font-size: 20pt; margin: 0 0 0.18in; }
.label { font-size: 8pt; letter-spacing: .08em; text-transform: uppercase; font-weight: 700; color: ${C["ink-soft"]}; }
.thesis { font-size: 13pt; line-height: 1.5; max-width: 9in; }
.stamp { display: inline-block; border: 2px solid ${C.stamp}; color: ${C.stamp}; padding: 3px 8px; font-size: 8.5pt; letter-spacing: .08em; font-weight: 700; }
.tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.18in; margin-bottom: 0.25in; }
.tile { background: ${C["paper-2"]}; border: 1px solid ${C.rule}; padding: 10px 12px; }
.tile .v { font-size: 17pt; margin-top: 4px; font-variant-numeric: tabular-nums; }
.fulcrum { color: ${C.stamp}; }
.rung { display: inline-block; border: 1px solid currentColor; font-size: 6.5pt; letter-spacing: .06em; padding: 0 3px; margin-left: 5px; vertical-align: middle; color: ${C["ink-soft"]}; }
.rung.R3 { color: ${C.warn}; } .rung.R4 { color: ${C.stamp}; }
table { border-collapse: collapse; width: 100%; font-size: 9.5pt; }
th { text-align: left; font-size: 7.5pt; letter-spacing: .08em; text-transform: uppercase; background: ${C["paper-2"]}; border-bottom: 2px solid ${C.ink}; padding: 5px 6px; }
td { border-bottom: 1px solid ${C.rule}; padding: 4px 6px; vertical-align: top; }
td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.abstain { color: ${C["ink-soft"]}; font-style: italic; }
.more { font-size: 8pt; color: ${C["ink-faint"]}; margin-top: 6px; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 0.35in; }
ul { margin: 0; padding-left: 1.1em; } li { margin-bottom: 6px; line-height: 1.4; }
.pos { color: ${C.ok}; } .neg { color: ${C.stamp}; }
@media print { html, body { background: ${C.paper}; } .slide { margin: 0; } }
`;

function fig(f: Figure): string {
  const abst = f.rung === "R4";
  const cls = abst ? "abstain" : f.stamp ? "fulcrum" : "";
  // A resolved figure with no display is a sheet bug; say so rather than print an empty cell.
  if (!abst && !f.display.trim()) return `<span class="abstain">not shown on the sheet</span>`;
  const value = abst ? "abstained" : esc(f.display);
  const rung = f.rung ? `<span class="rung ${f.rung}">${f.rung}</span>` : "";
  return `<span class="${cls}" data-figure>${value}</span>${rung}`;
}

function title(s: TitleSlide): string {
  const stamp = s.synthetic ? `<span class="stamp">SYNTHETIC EXAMPLE</span>` : "";
  return `<div class="label">Credit tear sheet${s.companyNumber ? `, company ${esc(s.companyNumber)}` : ""}</div>
<h1>${esc(s.company)}</h1>${stamp}
<p class="thesis">${esc(s.thesis)}</p>
<p class="label">Primary period ${esc(s.period)}. Built ${esc(s.generatedOn)} from the saved run.</p>`;
}

function snapshot(s: SnapshotSlide): string {
  const tiles = s.tiles.map((t) => `<div class="tile"><div class="label">${esc(t.label)}</div><div class="v">${fig(t)}</div></div>`).join("");
  const facts = s.facts.map((f) => `<tr><td>${esc(f.label)}</td><td>${esc(f.value)}</td></tr>`).join("");
  const ladder = s.ladder.map((l) => `<tr><td>${l.rung} ${esc(l.label)}</td><td class="n">${l.count}</td></tr>`).join("");
  return `<h2>Snapshot</h2><div class="tiles">${tiles}</div>
<div class="cols"><table><tr><th colspan="2">The company</th></tr>${facts}</table>
<table><tr><th>How each figure was resolved</th><th class="n">Figures</th></tr>${ladder}</table></div>`;
}

function financials(s: FinancialsSlide): string {
  const head = `<tr><th>£ unless stated</th>${s.periods.map((p) => `<th class="n">${esc(p)}</th>`).join("")}<th class="n">Change</th></tr>`;
  const body = s.rows
    .map((r) => `<tr><td>${esc(r.label)}</td>${r.cells.map((c) => `<td class="n">${fig(c)}</td>`).join("")}<td class="n">${r.delta === "abstained" ? `<span class="abstain">abstained</span>` : r.delta ? `<span data-figure>${esc(r.delta)}</span>` : ""}</td></tr>`)
    .join("");
  const more = s.hiddenRows ? `<div class="more">${s.hiddenRows} more rows on the sheet and in the model.</div>` : "";
  return `<h2>Financials</h2><table>${head}${body}</table>${more}`;
}

function capital(s: CapitalSlide): string {
  const rows = s.rows.length
    ? s.rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.rank)}</td><td>${esc(r.provider)}</td><td>${esc(r.security)}</td><td class="n">${fig(r.amount)}</td></tr>`).join("")
    : `<tr><td colspan="5" class="abstain">No capital structure lines on the sheet.</td></tr>`;
  const f = s.facilities;
  let fac: string;
  if (f.status !== "found") {
    fac = `<p class="abstain">Facilities from the debt note: ${f.status === "none" ? "not read." : "abstained."} ${esc(f.reason ?? "")}</p>`;
  } else {
    const cols = ["Drawn", "Committed", "Maturity", "Rate or margin", "Security"];
    const body = f.rows
      .map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.page)}</td>${(["drawn", "committed", "maturity", "rateOrMargin", "security"] as const).map((k) => `<td${k === "drawn" || k === "committed" ? ' class="n"' : ""}>${!r.cells[k] ? "" : r.cells[k] === "abstained" || r.cells[k] === "not printed" ? `<span class="abstain">${r.cells[k]}</span>` : `<span data-figure>${esc(r.cells[k])}</span>`}</td>`).join("")}</tr>`)
      .join("");
    const more = f.hiddenRows ? `<div class="more">${f.hiddenRows} more facilities on the sheet.</div>` : "";
    fac = `<table><tr><th>Facility, as the note prints it</th><th>Page</th>${cols.map((c, i) => `<th${i < 2 ? ' class="n"' : ""}>${c}</th>`).join("")}</tr>${body}</table>${more}
<div class="more">Read from the debt note${f.pages.length ? `, pages ${f.pages.join(", ")}` : ""}${f.caption ? `. Unit as printed: ${esc(f.caption)}` : ""}. Rows in the order the note prints them. No seniority or fulcrum is inferred.</div>`;
  }
  return `<h2>Capital structure</h2><table><tr><th>Instrument</th><th>Rank</th><th>Provider</th><th>Security</th><th class="n">Amount</th></tr>${rows}</table>
<h2 style="margin-top:0.25in;font-size:14pt">Facilities from the debt note</h2>${fac}`;
}

function catalysts(s: CatalystsSlide): string {
  const items = s.items.length
    ? `<ul>${s.items.map((i) => `<li><span class="${i.direction === "positive" ? "pos" : i.direction === "negative" ? "neg" : ""}">${esc(i.label)}.</span> ${esc(i.detail)} <span class="label">${esc(i.cite)}</span></li>`).join("")}</ul>`
    : `<p class="abstain">No cited catalyst was found in the filings on this sheet. None is inferred.</p>`;
  const narr = s.narrative.length ? `<ul>${s.narrative.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : `<p class="abstain">No narrative on the sheet.</p>`;
  return `<h2>Catalysts and points to note</h2><div class="cols"><div><div class="label">Cited signals</div>${items}</div><div><div class="label">From the sheet</div>${narr}</div></div>`;
}

function sources(s: SourcesSlide): string {
  const refs = s.references.map((r) => `<tr><td class="n">[${r.n}]</td><td>${esc(r.document)}</td><td>${esc(r.locator)}</td><td class="n">${r.backs}</td></tr>`).join("");
  const more = s.hiddenRefs ? `<div class="more">${s.hiddenRefs} more sources in the references pack.</div>` : "";
  return `<h2>Sources and disclaimer</h2><table><tr><th class="n">Ref</th><th>Document</th><th>Where</th><th class="n">Figures</th></tr>${refs}</table>${more}
<p class="more">Verification checks: ${s.verification.passed} passed, ${s.verification.failed} failed.</p>
<p>${esc(T.notAdvice)} Figures are read from the filings cited. Where a figure could not be verified it is marked abstained. Check the cited page before relying on any figure.</p>
<p class="more">${esc(T.oglAttribution)}</p>`;
}

function render(s: Slide): string {
  switch (s.kind) {
    case "title": return title(s);
    case "snapshot": return snapshot(s);
    case "financials": return financials(s);
    case "capital": return capital(s);
    case "catalysts": return catalysts(s);
    case "sources": return sources(s);
  }
}

export function renderDeckHtml(deck: Deck, opts: { autoprint?: boolean } = {}): string {
  const n = deck.slides.length;
  const slides = deck.slides
    .map((s, i) => `<section class="slide" data-kind="${s.kind}"><div class="band"><span>Built on public registers</span><span class="brand">${esc(T.name)}</span></div>
${render(s)}
<div class="foot"><span>${esc(T.notAdvice)}</span><span>${i + 1} of ${n}</span></div></section>`)
    .join("\n");
  const script = opts.autoprint ? `<script>${AUTOPRINT_SCRIPT}</script>` : "";
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>${esc(deck.title)}</title>
<meta name="robots" content="noindex"><style>${CSS}</style></head><body>${slides}${script}</body></html>`;
}

export function deckCsp(autoprint: boolean): string {
  return `default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src ${autoprint ? `'${AUTOPRINT_HASH}'` : "'none'"}; base-uri 'none'; form-action 'none'`;
}
