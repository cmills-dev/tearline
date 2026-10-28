// eval/gold/uk-run.ts
// The UK eval gate (WP-BE13). `npm run eval` runs it after the extraction and SEC gates.
//
// What it does. Every UK gold filing goes through the path a live run takes, offline:
//   - scans: readVision (lib/sources/companiesHouseLive.ts, the function production calls) with the
//     double read, the debt-note facility read, the filing's own accounts type and production's
//     page-finding threshold, then mapLiveToManifest, which lands the figures on the sheet. Every
//     model call is answered from eval/gold/fixtures/uk/<folder>/reads.json (uk-reads.ts). No
//     network, no key, no spend.
//   - iXBRL: extractFinancials on the frozen filing.xhtml, then mapLiveToManifest, so borrowings,
//     net debt, EBITDA and leverage come out of the resolution ladder as they do live.
//   - ESEF: extractEsefFinancials on the frozen filing.json.
// Each surfaced figure is compared with the gold set (uk.ts).
//
// What fails it (exit 1): a wrongly surfaced figure. That is a surfaced value that contradicts a
// gold value, a figure surfaced where the gold says the right answer is to abstain, a facility
// cell that contradicts a gold facility, or a sheet value that differs from the figure the double
// read agreed. An abstention where the gold has a value is reported and counted, never a failure:
// WP-BE10 showed the engine's error is omission, and a gate that punishes caution gets caution
// removed.
//
// What stops it (exit 2): a stale recording. When the current code makes a model call the
// recording does not have, or sends a request different from the one recorded, that filing is not
// scored, because its answers would be to a different question. `npm run eval:uk:live` re-records.
//
// What it will not say. Precision is printed per gold label (cam-checked, cam-corrected,
// claude-checked, tie-checked, tag-derived, candidate), each with its counts, and never pooled.
// No figure in the set has been checked by a person today (isPersonChecked), and the output says so.
// The gold is never edited to fit the engine: a disagreement is printed as a finding.
//
// Run:  npm run eval            (all three gates)
//       npx tsx eval/gold/uk-run.ts [--verbose]
//       npm run eval:uk:live     (prints what re-recording would cost; spends nothing)
//       npm run eval:uk:live -- --spend [--case <company number>] [--cap <GBP>]

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryCache } from "../../lib/cache/cache";
import { readVision, mapLiveToManifest, type SelectedFilingDocument } from "../../lib/sources/companiesHouseLive";
import { extractFinancials } from "../../lib/sources/ixbrl";
import { extractEsefFinancials, type EsefDoc } from "../../lib/sources/esef";
import { DoubleReadVerifier } from "../../lib/vision/verify";
import { DebtNoteFacilityReader } from "../../lib/vision/capitalStructure";
import { PAGE_FINDER_MODEL_DEFAULT, PAGE_FINDING_ABOVE_PAGES } from "../../lib/vision/pages";
import { BASE_LINE_KEYS } from "../../lib/vision/types";
import { labelForAccountsTypeKey } from "../../lib/resolve/accountsType";
import type { CompanyProfile, ChargesList } from "../../lib/sources/companiesHouse";
import type { Fact, FactManifest, CapitalStructure } from "../../lib/engine/types";
import { VISION_METRICS, type VisionLines } from "../../lib/sources/visionAccounts";
import type { StructuredLLMProvider } from "../../lib/llm/types";
import { UK_GOLD, STATUS_MEANING, isPersonChecked, type UkFigureStatus, type UkGoldCase } from "./uk";
import { compareToGold, rowForGold } from "./uk-facilities";
import { loadReads, saveReads, replayProviders, recordingProviders, versionOf, UK_FIXTURES, type RecordedCall, type CaseReads, type ReplayLog } from "./uk-reads";

const here = dirname(fileURLToPath(import.meta.url));
const PRODUCT = join(here, "..", "..");

// ---------------------------------------------------------------------------
// Running one filing through the real path
// ---------------------------------------------------------------------------

export interface ScanRun {
  lines: VisionLines;
  capitalStructure: CapitalStructure | null;
  manifest: FactManifest;
  stages: string[]; // the stage reports readVision made, for the verbose output
}

const NO_CHARGES: ChargesList = { items: [], total_count: 0 } as ChargesList;

export function profileFor(g: UkGoldCase): CompanyProfile {
  return {
    company_name: g.name,
    company_number: g.companyNumber,
    company_status: "active",
    type: "ltd",
    accounts: { last_accounts: { made_up_to: g.madeUpDate, type: g.accountsType } },
  } as CompanyProfile;
}

function metaOf(g: UkGoldCase): { filedOn?: string } {
  const p = join(UK_FIXTURES, g.folder, "meta.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
}

// The filing as the resolver would hand it to readVision.
export function selectedFor(g: UkGoldCase): SelectedFilingDocument {
  const formats = { pdf: true, ixbrl: false };
  return {
    filing: {
      transactionId: g.transactionId,
      type: g.filingType === "AAMD" ? "AAMD" : "AA",
      madeUpDate: g.madeUpDate,
      filedOn: metaOf(g).filedOn ?? g.madeUpDate,
      description: `accounts-with-accounts-type-${g.accountsType}`,
      accountsType: labelForAccountsTypeKey(g.accountsType),
      documentMetadataUrl: "",
      formats,
    },
    formats,
    contentUrl: null,
    pageCount: g.pageCount,
  };
}

export async function runScan(g: UkGoldCase, reader: StructuredLLMProvider, finder: StructuredLLMProvider): Promise<ScanRun> {
  const bytes = new Uint8Array(readFileSync(join(UK_FIXTURES, g.folder, "filing.pdf")));
  const cache = new InMemoryCache();
  const stages: string[] = [];
  const selected = selectedFor(g);
  const result = await readVision(
    bytes,
    selected,
    g.companyNumber,
    g.pageCount,
    "auto",
    new DoubleReadVerifier({ provider: reader, cache }),
    (stage, status, detail) => stages.push(`${stage} ${status}: ${detail}`),
    { provider: reader, pageFinder: finder, cache },
    new DebtNoteFacilityReader({ provider: reader, cache })
  );
  const manifest = mapLiveToManifest(profileFor(g), NO_CHARGES, {
    vision: result.lines,
    visionRead: result.read,
    filing: selected.filing,
    capitalStructure: result.capitalStructure,
  });
  return { lines: result.lines, capitalStructure: result.capitalStructure, manifest, stages };
}

export async function replayScan(g: UkGoldCase, reads: CaseReads): Promise<{ run: ScanRun; log: ReplayLog; stale: string[] }> {
  const log: ReplayLog = { served: [], missing: [] };
  const { reader, finder } = replayProviders(reads, log);
  const run = await runScan(g, reader, finder);
  const stale = [
    ...log.missing.map((s) => `the current code calls "${s}", which has no recording`),
    ...log.served.filter((s) => s.fingerprint === "different").map((s) => `the "${s.stage}" request differs from the one recorded`),
    ...log.served.filter((s) => s.version === "old").map((s) => `"${s.stage}" was recorded under ${s.recordedVersion}; the code now runs ${versionOf(s.stage)}`),
  ];
  return { run, log, stale };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export type Verdict = "right" | "wrong-value" | "surfaced-not-there" | "sheet-differs" | "abstained" | "abstained-rightly";
export const FAILING: Verdict[] = ["wrong-value", "surfaced-not-there", "sheet-differs"];

export interface Scored {
  company: string;
  what: string; // the gold metric, a derived line, or a facility cell set
  status: UkFigureStatus;
  gold: string;
  verdict: Verdict;
  detail: string;
}

const gbp = (n: number) => `${n < 0 ? "-" : ""}£${Math.abs(n).toLocaleString("en-GB")}`;
const goldText = (v: number | "ABSTAIN") => (v === "ABSTAIN" ? "ABSTAIN" : gbp(v));

// The facts on the sheet for one engine metric, whatever period they landed under.
const factsFor = (m: FactManifest, metric: string): Fact[] => Object.values(m.facts).filter((f) => f.metric === metric);

export function scoreScan(g: UkGoldCase, run: ScanRun): { rows: Scored[]; unscored: string[] } {
  const rows: Scored[] = [];
  const unscored: string[] = [];
  const goldFigures = g.figures.filter((f) => f.method === "agent-read" && !f.document && (BASE_LINE_KEYS as readonly string[]).includes(f.metric));

  for (const f of goldFigures) {
    const fig = run.lines.figures.find((x) => x.key === f.metric);
    const base = { company: g.name, what: f.metric, status: f.status, gold: goldText(f.value) };
    if (!fig) {
      const why = run.lines.abstentions.find((a) => a.key === f.metric)?.reason ?? "not returned";
      rows.push({ ...base, verdict: f.value === "ABSTAIN" ? "abstained-rightly" : "abstained", detail: why });
      continue;
    }
    // Gold keeps the printed sign, and so does the double read's evidence. fig.value applies the
    // engine's liability convention, so it is compared with the sheet below, not with the gold.
    const pounds = fig.tag.evidence!.pounds;
    const where = `surfaced "${fig.line.figureText}" ${fig.line.scaleCaption} on PDF page ${fig.line.pdfPageIndex} (${fig.line.printedLabel ?? ""})`;
    if (f.value === "ABSTAIN") {
      rows.push({ ...base, verdict: "surfaced-not-there", detail: `${where}; the gold says the right answer is to abstain` });
      continue;
    }
    // A liability or a cost goes on the sheet by its size (lib/sources/visionAccounts.ts): the same
    // lease liability prints "(659)" on the balance sheet and "659" in its note. So those lines are
    // compared by size, and a sign that differs from the gold's page is named, not failed (WP-BE14-LIVE-2).
    // A signed line (a loss, net liabilities, net cash) keeps its sign, and a wrong sign fails it.
    const bySize = VISION_METRICS[f.metric as keyof typeof VISION_METRICS]?.nature !== "signed";
    const differs = bySize ? Math.abs(Math.abs(pounds) - Math.abs(f.value)) >= 0.01 : Math.abs(pounds - f.value) >= 0.01;
    if (differs) {
      rows.push({ ...base, verdict: "wrong-value", detail: `${where}; gold "${f.printedText}" ${f.scaleCaption} on PDF page ${f.pdfPage} (${f.printedLabel ?? ""})` });
      continue;
    }
    const signNote = Math.sign(pounds) !== Math.sign(f.value) ? [`printed sign differs from the gold's page (${where}; gold "${f.printedText}" on PDF page ${f.pdfPage}), same size`] : [];
    rows.push({ ...base, verdict: "right", detail: [...fig.tags, ...signNote].join(", ") });
  }

  // The sheet must show what the double read agreed, whether or not the gold has the figure.
  for (const fig of run.lines.figures) {
    const onSheet = factsFor(run.manifest, fig.metric).filter((x) => x.value !== null && x.provenance?.sourceId === "ch-live-accounts-vision");
    const same = onSheet.some((x) => x.value === fig.value);
    if (!same) {
      rows.push({
        company: g.name,
        what: `${fig.key} on the sheet`,
        status: goldFigures.find((f) => f.metric === fig.key)?.status ?? "candidate",
        gold: gbp(fig.value),
        verdict: "sheet-differs",
        detail: onSheet.length ? `the sheet shows ${onSheet.map((x) => x.value).join(", ")} where the double read agreed ${fig.value}` : "the double read agreed this figure and it did not reach the sheet",
      });
    }
    if (!goldFigures.some((f) => f.metric === fig.key)) unscored.push(`${g.name} ${fig.key} ${gbp(fig.tag.evidence!.pounds)} (${fig.tags.join(", ")})`);
  }

  // Facilities from the debt note.
  for (const gf of g.facilities ?? []) {
    const cs = run.capitalStructure;
    const row = cs ? rowForGold(cs.rows, gf) : null;
    const cmp = compareToGold(gf, row);
    const base = { company: g.name, what: `facility "${gf.nameAsPrinted}"`, status: gf.status, gold: gf.amount !== undefined ? gbp(gf.amount) : "see quote" };
    if (cmp.contradictions.length) {
      rows.push({ ...base, verdict: "wrong-value", detail: cmp.contradictions.join("; ") });
    } else if (row?.status === "found" && cmp.agreed.length) {
      rows.push({ ...base, verdict: "right", detail: `agreed: ${cmp.agreed.join(", ")}${cmp.abstained.length ? `; abstained: ${cmp.abstained.join(", ")}` : ""}` });
    } else {
      const why = !cs ? "no facilities table: no debt note in the pages read" : cs.status === "abstain" && cs.rows.length === 0 ? cs.reason ?? "the table abstained" : "the row abstained";
      rows.push({ ...base, verdict: "abstained", detail: why });
    }
  }
  return { rows, unscored };
}

// Gold metric names to the engine's metric keys, for tag-derived and iXBRL lines.
const ENGINE_METRIC: Record<string, string> = {
  turnover: "turnover",
  operating_profit: "operatingProfit",
  cash_at_bank: "cash",
  interest_payable: "netInterest",
  net_assets: "netAssets",
  net_current_assets: "netCurrentAssets",
  current_assets: "currentAssets",
  total_assets_less_current_liabilities: "totalAssetsLessCurrentLiabilities",
  shareholders_funds: "shareholdersFunds",
  borrowings_total: "borrowings",
};

function scoreValue(g: UkGoldCase, what: string, status: UkFigureStatus, gold: number, got: Fact | undefined, tolerance = 0.5): Scored {
  const base = { company: g.name, what, status, gold: what === "leverage" ? `${gold}x` : gbp(gold) };
  if (!got || got.value === null || typeof got.value !== "number") {
    return { ...base, verdict: "abstained", detail: got?.attemptLog?.at(-1)?.detail ?? "not on the sheet" };
  }
  const ok = Math.abs(got.value - gold) < tolerance;
  return {
    ...base,
    verdict: ok ? "right" : "wrong-value",
    detail: `${got.rung}: ${got.value}${ok ? "" : ` against gold ${gold}`}${got.provenance?.snippet ? `; ${got.provenance.snippet.slice(0, 160)}` : ""}`,
  };
}

// The weakest label among a derived line's inputs is the label the line is scored under.
const LABEL_ORDER: UkFigureStatus[] = ["cam-checked", "cam-corrected", "claude-checked", "tie-checked", "tag-derived", "candidate"];
const weakest = (ss: UkFigureStatus[]) => ss.reduce((a, b) => (LABEL_ORDER.indexOf(b) > LABEL_ORDER.indexOf(a) ? b : a));

export function scoreIxbrl(g: UkGoldCase): { rows: Scored[]; manifest: FactManifest } {
  const xml = readFileSync(join(UK_FIXTURES, g.folder, "filing.xhtml"), "utf8");
  const extracted = extractFinancials(xml) ?? undefined;
  const manifest = mapLiveToManifest(profileFor(g), NO_CHARGES, { extracted });
  const on = (metric: string) => factsFor(manifest, metric).find((f) => f.value !== null) ?? factsFor(manifest, metric)[0];
  const rows: Scored[] = [];
  const gold = (m: string) => g.figures.find((f) => f.metric === m);
  for (const f of g.figures) {
    const metric = ENGINE_METRIC[f.metric];
    if (!metric || f.value === "ABSTAIN") continue;
    rows.push(scoreValue(g, f.metric, f.status, f.value, on(metric)));
  }
  // Derived lines, where the gold holds every input. Net debt and leverage are the engine's
  // definitions (borrowings less cash; net debt over operating profit plus tagged depreciation and
  // amortisation), computed here from the gold's printed inputs, never from the engine's output.
  const b = gold("borrowings_total"), c = gold("cash_at_bank"), op = gold("operating_profit"), d = gold("depreciation_tangible"), a = gold("amortisation");
  if (b && c && typeof b.value === "number" && typeof c.value === "number") {
    const netDebt = b.value - c.value;
    rows.push(scoreValue(g, "net_debt (borrowings less cash)", weakest([b.status, c.status]), netDebt, on("netDebt")));
    if (op && d && a && typeof op.value === "number" && typeof d.value === "number" && typeof a.value === "number") {
      const ebitda = op.value + d.value + a.value;
      rows.push(scoreValue(g, "ebitda (operating profit + tagged D&A)", weakest([op.status, d.status, a.status]), ebitda, on("ebitda")));
      const lev = Math.round((netDebt / ebitda) * 100) / 100;
      rows.push(scoreValue(g, "leverage", weakest([b.status, c.status, op.status, d.status, a.status]), lev, on("leverage"), 0.005));
    }
  }
  return { rows, manifest };
}

export function scoreEsef(g: UkGoldCase): Scored[] {
  const p = join(UK_FIXTURES, g.folder, "filing.json");
  const doc = JSON.parse(readFileSync(existsSync(p) ? p : join(PRODUCT, "test", "fixtures", "tesco_esef.json"), "utf8")) as EsefDoc;
  const ex = extractEsefFinancials(doc);
  return g.figures
    .filter((f) => ENGINE_METRIC[f.metric] && f.value !== "ABSTAIN")
    .map((f) => {
      const line = ex?.lines.find((l) => l.metric === ENGINE_METRIC[f.metric]);
      const got = line ? ({ value: line.value, rung: "R1", provenance: { snippet: `${line.concept} = ${line.rawText}` } } as unknown as Fact) : undefined;
      return scoreValue(g, f.metric, f.status, f.value as number, got);
    });
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface GateResult {
  rows: Scored[];
  unscored: string[];
  stale: { g: UkGoldCase; why: string[] }[];
  notRun: string[];
  unfingerprinted: string[];
  extra: string[]; // lines worth printing: the filing's own EBITDA, and so on
}

export async function gate(verbose: boolean): Promise<GateResult> {
  const out: GateResult = { rows: [], unscored: [], stale: [], notRun: [], unfingerprinted: [], extra: [] };
  for (const g of UK_GOLD) {
    if (g.kind === "esef") {
      out.rows.push(...scoreEsef(g));
      continue;
    }
    if (g.kind === "ixbrl") {
      const { rows, manifest } = scoreIxbrl(g);
      out.rows.push(...rows);
      const printed = g.figures.find((f) => f.metric === "ebitda_as_printed");
      const nd = factsFor(manifest, "netDebt").find((f) => typeof f.value === "number");
      if (printed && typeof printed.value === "number" && nd && typeof nd.value === "number") {
        out.extra.push(
          `${g.name}: on the company's own EBITDA of ${gbp(printed.value)} (it adds back right-of-use depreciation, which is printed but not tagged), leverage would be ${(Math.round((nd.value / printed.value) * 100) / 100).toFixed(2)}x.`
        );
      }
      if (!g.figures.some((f) => f.metric === "borrowings_total")) {
        const b = factsFor(manifest, "borrowings").find((f) => typeof f.value === "number");
        out.extra.push(`${g.name}: no borrowings in the gold set; the engine ${b ? `shows ${gbp(b.value as number)}` : "abstains on borrowings, net debt and leverage"}.`);
      }
      continue;
    }
    if (!g.scan) continue;
    const reads = loadReads(g.folder);
    const scoredFigures = g.figures.filter((f) => f.method === "agent-read" && !f.document).length + (g.facilities?.length ?? 0);
    if (!reads) {
      if (scoredFigures) out.notRun.push(`${g.name}: no recorded reads (${scoredFigures} gold figures and facilities not scored)`);
      continue;
    }
    const { run, log, stale } = await replayScan(g, reads);
    if (stale.length) {
      out.stale.push({ g, why: [...new Set(stale)] });
      continue;
    }
    const unfp = log.served.filter((s) => s.fingerprint === "not-recorded").map((s) => s.stage.replace(/^classify:.*/, "classify"));
    if (unfp.length) out.unfingerprinted.push(`${g.name} (${[...new Set(unfp)].join(", ")})`);
    const s = scoreScan(g, run);
    out.rows.push(...s.rows);
    out.unscored.push(...s.unscored);
    if (verbose) for (const st of run.stages) console.log(`  [${g.companyNumber}] ${st}`);
  }
  return out;
}

// Exit codes. 1: a figure was wrongly surfaced, always. 2: a recording is stale, only under --strict
// (npm run eval:uk:strict), which is the release gate. Without --strict a stale filing is listed as
// unscored and needing a live re-record, and the run exits 0 on what it could score. Cam, 26 Sep:
// build around live calls with the recorded fixtures while the API account has no credit, and mark
// what needs a re-record. A run that scored no scan says so on its last line.
export function printGate(r: GateResult, verbose: boolean, strict = false): number {
  const all = UK_GOLD.flatMap((c) => c.figures);
  const person = all.filter(isPersonChecked).length;
  const fails = r.rows.filter((x) => FAILING.includes(x.verdict));
  const line = "=".repeat(78);

  console.log(`\nUK eval gate  (eval/gold/uk-run.ts)\n${line}`);
  console.log(`Gold figures checked by a person (cam-checked, cam-corrected): ${person} of ${all.length}.`);
  if (person === 0) console.log("NO FIGURE IN THIS SET HAS BEEN CHECKED BY A PERSON. Every rate below is against a machine-keyed answer.");
  console.log("-".repeat(78));
  console.log("Precision by gold label. Right of surfaced; abstentions are counted apart and are not failures.");
  console.log("A rate over a handful of figures is not a finding: read the counts first.");
  console.log(`  ${"label".padEnd(15)} ${"right".padStart(5)} ${"surf".padStart(5)} ${"prec".padStart(7)}  ${"abst".padStart(4)} of ${"val".padEnd(4)} ${"abstain-gold".padStart(12)}`);
  for (const s of LABEL_ORDER) {
    const rs = r.rows.filter((x) => x.status === s);
    const right = rs.filter((x) => x.verdict === "right").length;
    const surfaced = rs.filter((x) => ["right", ...FAILING].includes(x.verdict)).length;
    const abst = rs.filter((x) => x.verdict === "abstained").length;
    const valued = right + abst + rs.filter((x) => x.verdict === "wrong-value" || x.verdict === "sheet-differs").length;
    const abstGold = rs.filter((x) => x.verdict === "abstained-rightly" || x.verdict === "surfaced-not-there").length;
    const prec = surfaced ? `${((right / surfaced) * 100).toFixed(1)}%` : "n/a";
    console.log(
      `  ${s.padEnd(15)} ${String(right).padStart(5)} ${String(surfaced).padStart(5)} ${prec.padStart(7)}  ${String(abst).padStart(4)} of ${String(valued).padEnd(4)} ${`${rs.filter((x) => x.verdict === "abstained-rightly").length} of ${abstGold}`.padStart(12)}`
    );
  }
  console.log("  (right = surfaced and equal to gold; surf = surfaced; abst of val = abstained where gold has a value;");
  console.log("   abstain-gold = rightly abstained where the gold says abstain)");
  for (const s of LABEL_ORDER) console.log(`  ${s.padEnd(15)} ${STATUS_MEANING[s]}`);
  if (r.rows.some((x) => x.status === "tag-derived")) {
    console.log("  tag-derived figures were keyed by the same extractors that produce them: that row checks for regressions, not accuracy.");
  }

  console.log("-".repeat(78));
  if (fails.length) {
    console.log(`WRONGLY SURFACED: ${fails.length}. Each is a finding. The gold is not edited to make it pass.`);
    for (const f of fails) console.log(`  ${f.verdict.padEnd(18)} ${f.company.slice(0, 24).padEnd(24)} ${f.what.padEnd(28)} gold ${f.gold.padEnd(17)} [${f.status}]  ${f.detail}`);
  } else {
    console.log("Wrongly surfaced: 0.");
  }
  const abstained = r.rows.filter((x) => x.verdict === "abstained");
  console.log(`Abstained where the gold has a value: ${abstained.length} (reported, not a failure).`);
  for (const f of abstained) console.log(`  ${f.company.slice(0, 24).padEnd(24)} ${f.what.padEnd(28)} gold ${f.gold.padEnd(17)} [${f.status}]  ${f.detail.slice(0, 200)}`);
  for (const e of r.extra) console.log(`Note: ${e}`);

  if (verbose) {
    console.log("\nEvery scored row:");
    for (const f of r.rows) console.log(`  ${f.verdict.padEnd(18)} ${f.company.slice(0, 24).padEnd(24)} ${f.what.padEnd(28)} gold ${f.gold.padEnd(17)} [${f.status}]  ${f.detail.slice(0, 220)}`);
    console.log("\nSurfaced with no gold figure to score against:");
    for (const u of r.unscored) console.log(`  ${u}`);
  }
  if (r.unfingerprinted.length) {
    console.log(`Replayed from reads recorded before request fingerprints (the answers replay, but nothing proves the request is unchanged): ${r.unfingerprinted.join("; ")}.`);
  }
  if (r.notRun.length) {
    console.log("Not run:");
    for (const n of r.notRun) console.log(`  ${n}`);
  }
  if (r.stale.length) {
    console.log(`STALE, NOT SCORED: ${r.stale.length} filing(s). Re-record with: npm run eval:uk:live -- --spend`);
    for (const s of r.stale) console.log(`  ${s.g.name} (${s.g.companyNumber}): ${s.why.slice(0, 3).join("; ")}${s.why.length > 3 ? `; and ${s.why.length - 3} more` : ""}`);
  }
  console.log("");
  if (fails.length) return 1;
  if (r.stale.length) {
    const scans = UK_GOLD.filter((c) => c.scan).length;
    console.log(`NOT A RELEASE PASS: ${r.stale.length} of ${scans} scanned filings were not scored and need a live re-record (API credit).`);
    console.log(`The release gate is npm run eval:uk:strict, which exits 2 until they are re-recorded.\n`);
    return strict ? 2 : 0;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// eval:uk:live: re-record the reads under the current code
// ---------------------------------------------------------------------------

// What a filing's re-recording should cost, from its last recording where that recording still
// matches the current path, otherwise from what such a read has cost before (WP-BE05, WP-BE15,
// WP-BE16, WP-BE18): a page-found read about GBP 0.45 in all; a whole read about GBP 0.009 a page
// plus a second read and a debt-note read.
function estimateGbp(g: UkGoldCase, reads: CaseReads | null, stale: boolean, reuse: RecordedCall[]): number {
  if (reads && !stale) return reads.calls.reduce((s, c) => s + (c.gbp ?? 0.05), 0);
  if (g.pageCount > PAGE_FINDING_ABOVE_PAGES) return 0.45;
  const firstRead = reuse.some((c) => c.stage === "first-read") ? 0 : g.pageCount * 0.01;
  return firstRead + 0.08 + 0.04; // a second read and a debt-note read
}

// Recorded calls a re-recording may keep instead of paying for again: only the whole-document first
// read of a filing production also reads whole (60 pages or fewer), recorded under the current prompt
// and schema. Its request is the same filing, the same prompt version and the same pages, but it was
// not fingerprinted, so the new recording keeps its null fingerprint and says so.
function reusable(g: UkGoldCase, reads: CaseReads | null): RecordedCall[] {
  if (!reads || g.pageCount > PAGE_FINDING_ABOVE_PAGES) return [];
  return reads.calls.filter((c) => c.stage === "first-read" && c.version === versionOf("first-read"));
}

// The branch and commit the recording was made on. A recording only replays as fresh under the code
// that made it: on 27 Sep nine reads recorded on preflight/rerecord (which carried WP-BE23 and an
// older page cutter) read as stale on wp/be14-live, and nothing in the file said where they came
// from. Now the file says, so a stale read can be traced to its branch in one look.
function recordedAtCommit(): string {
  try {
    const git = (...a: string[]) => execFileSync("git", a, { cwd: PRODUCT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return `on ${git("rev-parse", "--abbrev-ref", "HEAD")} at ${git("rev-parse", "--short", "HEAD")}`;
  } catch {
    return "on an unknown commit";
  }
}

async function live(args: string[]): Promise<number> {
  const spend = args.includes("--spend");
  const only = args.includes("--case") ? args[args.indexOf("--case") + 1] : null;
  const cap = args.includes("--cap") ? Number(args[args.indexOf("--cap") + 1]) : 2;
  const all = args.includes("--all");

  const plan: { g: UkGoldCase; reads: CaseReads | null; why: string; est: number; reuse: RecordedCall[] }[] = [];
  for (const g of UK_GOLD.filter((c) => c.scan && (!only || c.companyNumber === only))) {
    const reads = loadReads(g.folder);
    if (!reads && !only) continue; // Pret has no reads and its case keys nothing a scan can score
    let why = "";
    let stale = true;
    if (reads) {
      const r = await replayScan(g, reads).catch((e) => ({ stale: [String(e)], log: { served: [], missing: [] } as ReplayLog }));
      stale = r.stale.length > 0;
      const unfp = r.log.served.some((s) => s.fingerprint === "not-recorded");
      why = stale ? `stale: ${[...new Set(r.stale)].slice(0, 2).join("; ")}` : unfp ? "current, but recorded before request fingerprints" : "current and fingerprinted";
      // A filing that still replays is re-recorded only when asked for by --all or --case.
      if (!stale && !all && !only) continue;
    } else {
      why = "no reads recorded";
    }
    const reuse = all ? [] : reusable(g, reads);
    plan.push({ g, reads, why: reuse.length ? `${why}; keeps the current first read` : why, est: estimateGbp(g, reads, stale, reuse), reuse });
  }
  const total = plan.reduce((s, p) => s + p.est, 0);
  console.log(`\neval:uk:live: re-record the UK gold reads under the current code (cap GBP ${cap.toFixed(2)})\n${"=".repeat(78)}`);
  if (!plan.length) {
    console.log("Nothing to re-record: every replayed filing matches the current code. --all re-records every filing anyway.\n");
    return 0;
  }
  for (const p of plan) console.log(`  ${p.g.name.slice(0, 30).padEnd(30)} ${String(p.g.pageCount).padStart(3)} pages  est GBP ${p.est.toFixed(2)}  ${p.why}`);
  console.log(`  ${"Estimated total".padEnd(42)} GBP ${total.toFixed(2)}`);
  if (!spend) {
    console.log("\nNothing was spent. Add --spend to make these calls. The run stops before any call that would pass the cap.\n");
    return 0;
  }

  const envFile = join(PRODUCT, ".env.local");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const apiKey = process.env.LLM_API_KEY?.trim();
  if (!apiKey) {
    console.log("LLM_API_KEY is not set (product/.env.local). Nothing was spent.\n");
    return 3;
  }
  const readerModel = process.env.LLM_MODEL?.trim() || "claude-opus-5";
  const finderModel = process.env.PAGE_FINDER_MODEL?.trim() || PAGE_FINDER_MODEL_DEFAULT;
  let spent = 0;
  for (const p of plan) {
    if (spent + p.est > cap) {
      console.log(`  stop: ${p.g.name} is estimated at GBP ${p.est.toFixed(2)} and GBP ${spent.toFixed(4)} is spent, which would pass the cap.`);
      break;
    }
    const rec = recordingProviders({ apiKey, readerModel, finderModel, capGbp: cap, alreadySpentGbp: () => spent, reuse: p.reuse });
    const started = Date.now();
    let error: string | null = null;
    try {
      await runScan(p.g, rec.reader, rec.finder);
    } catch (e) {
      error = String(e);
    }
    spent += rec.spentGbp();
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    // The run swallows a failed call into an abstention, so a complete recording is checked by
    // replaying it: if the replay asks for a stage the recording lacks, it is not saved.
    const candidate: CaseReads = {
      note: `Recorded model reads of ${p.g.name} (${p.g.folder}/filing.pdf), made by npm run eval:uk:live through the real path and replayed offline by eval/gold/uk-run.ts.`,
      companyNumber: p.g.companyNumber,
      transactionId: p.g.transactionId,
      recordedWith: { accountsType: labelForAccountsTypeKey(p.g.accountsType), pageFindingAbovePages: PAGE_FINDING_ABOVE_PAGES, by: `eval:uk:live ${new Date().toISOString().slice(0, 10)}, reader ${readerModel}, finder ${finderModel}, ${recordedAtCommit()}` },
      calls: rec.calls,
    };
    const check = error ? null : await replayScan(p.g, candidate).catch(() => null);
    if (!error && check && check.stale.length === 0) {
      saveReads(p.g.folder, candidate);
      console.log(`  recorded ${p.g.name}: ${rec.calls.length} calls, GBP ${rec.spentGbp().toFixed(4)}, ${secs} s`);
    } else {
      const why = error ?? (check ? [...new Set(check.stale)].join("; ") : "the replay of the new recording failed");
      console.log(`  NOT saved ${p.g.name}: ${why}. GBP ${rec.spentGbp().toFixed(4)} spent, ${secs} s.`);
      for (const f of rec.failures.slice(0, 3)) console.log(`    ${f.stage} answered ${f.status}: ${f.body.replace(/\s+/g, " ")}`);
    }
    if (error?.includes("cap is reached")) break;
  }
  console.log(`Spent GBP ${spent.toFixed(4)} of the GBP ${cap.toFixed(2)} cap. Run npm run eval to score the new reads.\n`);
  return 0;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--live")) process.exit(await live(args));
  const verbose = args.includes("--verbose");
  const r = await gate(verbose);
  process.exit(printGate(r, verbose, args.includes("--strict")));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

