// scripts/validate-names.ts
// WP-BE10: the 30-name harness, with value checks.
//
//   npx tsx scripts/validate-names.ts                 run every name not yet in the results file
//   npx tsx scripts/validate-names.ts --limit 5 --cap-gbp 5
//   npx tsx scripts/validate-names.ts --report-only   rewrite the report from the results file
//
// Each name goes through the run job exactly as a user's would (runToCompletion, the default
// 120 second budget, group following on). Then three checks look at every figure it surfaced:
//
//   1. Provenance. Every non-abstaining fact must carry a source. A scan-read figure must carry
//      a page and the printed text, and the printed digits times a scale must give the value.
//      A derived figure must name inputs that are on the sheet.
//   2. Ties. Wherever both sides of an identity surface, the arithmetic must hold: net debt from
//      its inputs, borrowings from its maturity split, EBITDA from its parts, and net assets
//      against the total equity printed on the same balance sheet (the third read fetches that).
//   3. A third read of three figures, done by this script and not by the engine. For a scan it
//      is a fresh model call that is sent only the cited page and is told the printed caption
//      and the period, never the value. For inline XBRL it is this script's own parse of the
//      filer's tags. For a PDF text layer it is a search of the text for the quoted line.
//
// A figure with no provenance, a failed tie or a third read that disagrees is a SUSPECTED
// FABRICATION and fails the name. Nothing here can make the engine produce a number, and no
// check is relaxed to let a name pass.
//
// Money. Every model call logs one `llm.usage {json}` line with its GBP cost. This script reads
// those lines, so the cost it reports is the cost the engine's own logger priced. It stops
// before a name when the total has reached --cap-gbp, or when the per-name average says the next
// name would take it over. An HTTP 400 about credit from the Anthropic API stops the run.
//
// Companies House. Every call to the register or the document API passes through a pacing gate
// that keeps this process under 500 calls in any 5 minutes (CH allows 600).
//
// Results are appended to eval/names/results-<date>.jsonl one line per name, so a killed run
// resumes where it stopped. Exit codes: 0 all 30 ran and 25 or more passed; 1 all 30 ran and
// fewer than 25 passed; 3 the run stopped early (budget, credit, --limit), so no verdict.

// .env.local is not loaded by tsx. This import loads it, and runs before any lib module does.
import "./validate-names-env";
import { readFileSync, existsSync, appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const DATE = arg("date") ?? "2026-09-23";
const CAP_GBP = Number(arg("cap-gbp") ?? "12");
const LIMIT = arg("limit") ? Number(arg("limit")) : Infinity;
const ONLY = arg("only")?.split(",").map(Number) ?? null;
const REPORT_ONLY = argv.includes("--report-only");
const RERUN = arg("rerun")?.split(",").map(Number) ?? [];
const NAMES_CSV = join(ROOT, "eval/names/validation-30.csv");
const RESULTS = join(ROOT, `eval/names/results-${DATE}.jsonl`);
const REPORT = join(ROOT, `eval/names/report-${DATE}.md`);
// Hand-written, one entry per name: was the company the resolver landed on the one the list
// meant? The harness cannot know that, so a person or an agent that looked at the register
// says so here, with the evidence. "wrong" fails the name. Nothing else in this file is edited.
const ADJUDICATIONS = join(ROOT, `eval/names/adjudications-${DATE}.json`);
// Spend that reached the API but never reached a result line: an attempt killed mid-name. Kept by
// hand from the run log, and counted by the budget and the report like any other spend.
const UNRECORDED = join(ROOT, `eval/names/unrecorded-spend-${DATE}.json`);
function unrecorded(): { n: number; gbp: number; note: string }[] {
  return existsSync(UNRECORDED) ? JSON.parse(readFileSync(UNRECORDED, "utf8")) : [];
}
const SCRATCH = join(ROOT, ".scratch/wp-be10");
const THIRD_READ_MODEL = "claude-opus-5";
const PASS_MARK = 25;
const TOTAL_NAMES = 30;

// ---------------------------------------------------------------------------
// Types of the record written per name
// ---------------------------------------------------------------------------
interface UsageLine {
  label: string;
  model: string;
  gbp: number | null;
  ms: number;
}

interface NameResult {
  n: number;
  name: string;
  reason: string;
  startedAt: string;
  wallMs: number;
  outcome: "pass" | "fail";
  failReasons: string[];
  crashed: boolean;
  crash: string | null;
  runStatus: string;
  runReason: string | null;
  stageReached: string | null;
  stages: { stage: string; status: string; elapsedMs: number | null; detail: string | null }[];
  resolution: {
    kind: string; // resolved | needs-choice | none | excluded
    number: string | null;
    name: string | null;
    viaSuggestion: boolean;
    candidates: { number: string; name: string; status?: string }[];
  };
  builtNumbers: string[]; // every company number the builder was called with (group following)
  accountsType: string | null;
  group: unknown;
  filingDetail: string | null; // the builder's resolve line: type, accounts type, made-up date
  fetchDetail: string | null; // size, pages, scan or text layer
  figures: FigureRecord[];
  abstentions: { factId: string; label: string; reason: string }[];
  basisAbstentions: number; // WP-BE18's basis check
  checks: CheckResult[];
  suspectedFabrications: string[];
  exports: { tearSheet: boolean; csv: boolean; xlsx: boolean; errors: string[] };
  costGbp: number;
  thirdReadCostGbp: number;
  usage: UsageLine[];
  chCalls: number;
  // A run that timed out: what its builder produced afterwards, checked the same way. Never part
  // of the verdict, because none of it reached a sheet.
  late: {
    finished: boolean;
    figures: number;
    note: string;
    figureRecords?: FigureRecord[];
    abstentions?: { factId: string; label: string; reason: string }[];
    checks?: CheckResult[];
    suspectedFabrications?: string[];
  } | null;
}

// ---------------------------------------------------------------------------
// The names
// ---------------------------------------------------------------------------
interface NameRow {
  n: number;
  name: string;
  reason: string;
}
function loadNames(): NameRow[] {
  const rows = parseCsv(readFileSync(NAMES_CSV, "utf8"));
  return rows.slice(1).map((r) => ({ n: Number(r[0]), name: r[1], reason: r[2] ?? "" }));
}
// Every line ever written, in order. A re-run appends; the latest line for a name is its result.
function loadAllResults(): NameResult[] {
  if (!existsSync(RESULTS)) return [];
  return readFileSync(RESULTS, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as NameResult);
}
function loadResults(): NameResult[] {
  const latest = new Map<number, NameResult>();
  for (const r of loadAllResults()) latest.set(r.n, r);
  return [...latest.values()];
}
interface Adjudication {
  resolution: "right" | "wrong" | "unclear";
  note: string;
}
function loadAdjudications(): Record<string, Adjudication> {
  return existsSync(ADJUDICATIONS) ? JSON.parse(readFileSync(ADJUDICATIONS, "utf8")) : {};
}
// The verdict with the resolution adjudication applied. A sheet of the wrong company fails.
function verdict(r: NameResult, adj: Record<string, Adjudication>): { outcome: "pass" | "fail"; reasons: string[] } {
  const a = adj[String(r.n)];
  const reasons = [...r.failReasons];
  if (a?.resolution === "wrong") reasons.push(`resolved to the wrong entity: ${a.note}`);
  return { outcome: reasons.length ? "fail" : "pass", reasons };
}

// ---------------------------------------------------------------------------
// Spend: read the engine's own usage lines
// ---------------------------------------------------------------------------
let usageSink: UsageLine[] = [];
const rawLog = console.log.bind(console);
console.log = (...args: unknown[]) => {
  const first = args[0];
  if (typeof first === "string" && first.startsWith("llm.usage ")) {
    try {
      const u = JSON.parse(first.slice("llm.usage ".length));
      usageSink.push({ label: u.label ?? "", model: u.model, gbp: u.costGbp ?? null, ms: u.durationMs ?? 0 });
    } catch {
      /* an unreadable usage line is still printed below */
    }
  }
  rawLog(...args);
};
function sumGbp(lines: UsageLine[]): number {
  return lines.reduce((s, u) => s + (u.gbp ?? 0), 0);
}

// ---------------------------------------------------------------------------
// The network gate: Companies House pacing, and the credit stop
// ---------------------------------------------------------------------------
const CH_WINDOW_MS = 300_000;
const CH_MAX_IN_WINDOW = 500;
const chStamps: number[] = [];
let chCallsThisName = 0;
let creditExhausted: string | null = null;
const realFetch = globalThis.fetch.bind(globalThis);
function isCh(url: string): boolean {
  return /company-information\.service\.gov\.uk|companieshouse\.gov\.uk|document-api/.test(url);
}
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (isCh(url)) {
    for (;;) {
      const now = Date.now();
      while (chStamps.length && now - chStamps[0] > CH_WINDOW_MS) chStamps.shift();
      if (chStamps.length < CH_MAX_IN_WINDOW) break;
      const wait = CH_WINDOW_MS - (now - chStamps[0]) + 250;
      rawLog(`[harness] Companies House pacing: waiting ${Math.ceil(wait / 1000)} s`);
      await new Promise((r) => setTimeout(r, wait));
    }
    chStamps.push(Date.now());
    chCallsThisName++;
  }
  const res = await realFetch(input as RequestInfo, init);
  if (/api\.anthropic\.com/.test(url) && res.status === 400) {
    const body = await res.clone().text().catch(() => "");
    if (/credit/i.test(body)) creditExhausted = body.slice(0, 300);
  }
  return res;
}) as typeof fetch;

// ---------------------------------------------------------------------------
// Value parsing shared by the checks
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Check 1: provenance
// ---------------------------------------------------------------------------
import type { Fact, FactManifest } from "../lib/engine/types";
import {
  type CheckResult,
  type FigureRecord,
  digitsOf,
  figureRecord,
  goldChecks,
  parseCsv,
  pickThree,
  provenanceCheck,
  scaleOf,
  surfacedNumber,
  thirdReadIxbrl,
  thirdReadText,
  ties,
} from "../eval/names/checks";

// ---------------------------------------------------------------------------
// Check 2: ties
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Check 3: the third read
// ---------------------------------------------------------------------------
import { AnthropicProvider } from "../lib/llm/providers/anthropic";
import { cutPdfPages } from "../lib/vision/pages";
import { getLatestAccountsIxbrl, getLatestAccountsPdfBytes, getLatestAccountsPdfText } from "../lib/sources/companiesHouseLive";

const THIRD_SYSTEM = `You transcribe figures from UK statutory accounts. You are given a few pages cut out of a filing. For each requested item, find the line with the given caption for the given period, in the statement named, and copy the figure exactly as printed (keep brackets and commas). Also copy the unit caption printed at the head of that column or statement (for example "£'000", "£m", "£"), and the column heading. Never calculate, rescale or guess. If you cannot find the line, or the page does not print it, say found=false. Also, if a balance sheet is among the pages, copy the printed total equity (it may be captioned "Total equity", "Total shareholders' funds" or "Total shareholders' deficit") for the same period as the net assets line, with its unit caption.`;

const THIRD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items", "total_equity"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "found", "figure_text", "unit_caption", "column_heading", "excerpt_page"],
        properties: {
          id: { type: "string" },
          found: { type: "boolean" },
          figure_text: { type: "string" },
          unit_caption: { type: "string" },
          column_heading: { type: "string" },
          excerpt_page: { type: "integer" },
        },
      },
    },
    total_equity: {
      type: "object",
      additionalProperties: false,
      required: ["found", "figure_text", "unit_caption", "caption"],
      properties: {
        found: { type: "boolean" },
        figure_text: { type: "string" },
        unit_caption: { type: "string" },
        caption: { type: "string" },
      },
    },
  },
};

function captionFrom(snippet: string): { label: string | null; statement: string | null; periodEnd: string | null } {
  const label = /"([^"]+)" printed as/.exec(snippet)?.[1] ?? null;
  const parts = snippet.split(", ");
  const statement = parts.find((x, i) => i >= 2 && !/^period ended|^note /.test(x) && !/printed as/.test(x)) ?? null;
  const periodEnd = /period ended ([0-9-]+)/.exec(snippet)?.[1] ?? null;
  return { label, statement, periodEnd };
}

async function thirdReadScan(
  n: number,
  number: string,
  picks: Fact[],
  wantEquity: Fact | null,
): Promise<{ checks: CheckResult[]; equity: { value: number; text: string } | null; costGbp: number }> {
  const checks: CheckResult[] = [];
  const notRun = (detail: string) => picks.map((f) => ({ check: "third-read" as const, subject: f.id, outcome: "not-run" as const, detail }));
  const bytes = await getLatestAccountsPdfBytes(number).catch(() => null);
  if (!bytes) return { checks: notRun("the filing PDF could not be fetched again for the third read"), equity: null, costGbp: 0 };
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(join(SCRATCH, `filing-${n}.pdf`), bytes); // for a person to open; scratch, never staged
  const pages = [...new Set([...picks, ...(wantEquity ? [wantEquity] : [])].map((f) => f.provenance!.page!))];
  const subset = await cutPdfPages(bytes, pages);
  if (!subset) return { checks: notRun(`pages ${pages.join(", ")} could not be cut out of the PDF`), equity: null, costGbp: 0 };
  const items = picks.map((f) => {
    const c = captionFrom(f.provenance!.snippet);
    return { id: f.id, caption: c.label ?? f.label, statement: c.statement ?? "", periodEnd: c.periodEnd ?? f.period };
  });
  const user = [
    `The excerpt holds ${subset.pages.length} page(s).`,
    "Items to transcribe:",
    ...items.map((i) => `- id ${i.id}: the line captioned "${i.caption}"${i.statement ? ` in the ${i.statement}` : ""}, for the period ended ${i.periodEnd}.`),
    wantEquity ? "Also transcribe total equity from the balance sheet for the same period." : "total_equity: set found=false unless a balance sheet is on these pages.",
  ].join("\n");
  const provider = new AnthropicProvider(
    { provider: "anthropic", model: THIRD_READ_MODEL, apiKey: process.env.LLM_API_KEY ?? "", maxTokens: 2000 },
  );
  const before = usageSink.length;
  const sent = await provider.send({
    system: THIRD_SYSTEM,
    content: [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from(subset.bytes).toString("base64") } },
      { type: "text", text: user },
    ],
    maxTokens: 2000,
    outputSchema: THIRD_SCHEMA,
    label: `wp-be10-third-read:${number}`,
  });
  const costGbp = sumGbp(usageSink.slice(before));
  if (!sent.ok) return { checks: notRun(`the third read call failed (${sent.failure.kind}: ${sent.failure.detail.slice(0, 120)})`), equity: null, costGbp };
  let parsed: { items: { id: string; found: boolean; figure_text: string; unit_caption: string; column_heading: string }[]; total_equity: { found: boolean; figure_text: string; unit_caption: string; caption: string } };
  try {
    parsed = JSON.parse(sent.text);
  } catch {
    return { checks: notRun("the third read came back unparseable"), equity: null, costGbp };
  }
  for (const f of picks) {
    const got = parsed.items.find((i) => i.id === f.id);
    if (!got || !got.found) {
      checks.push({ check: "third-read", subject: f.id, outcome: "not-run", detail: "the third read did not find the line; inconclusive, not counted either way" });
      continue;
    }
    const d = digitsOf(got.figure_text);
    const s = scaleOf(got.unit_caption);
    if (d === null || s === null) {
      checks.push({ check: "third-read", subject: f.id, outcome: "not-run", detail: `the third read gave "${got.figure_text}" under "${got.unit_caption}", which the harness could not turn into pounds` });
      continue;
    }
    const third = Math.abs(d * s);
    const engine = Math.abs(f.value as number);
    const ok = Math.abs(third - engine) <= s / 2 + 1;
    checks.push({
      check: "third-read",
      subject: f.id,
      outcome: ok ? "pass" : "fail",
      detail: `engine "${f.provenance!.printedText}" = ${f.value}; third read "${got.figure_text}" under "${got.unit_caption}" (column "${got.column_heading}") = ${third}`,
    });
  }
  let equity: { value: number; text: string } | null = null;
  const te = parsed.total_equity;
  if (wantEquity && te?.found) {
    const d = digitsOf(te.figure_text);
    const s = scaleOf(te.unit_caption);
    if (d !== null && s !== null) equity = { value: d * s, text: `${te.figure_text} under ${te.unit_caption} (${te.caption})` };
  }
  return { checks, equity, costGbp };
}

// ---------------------------------------------------------------------------
// Check 4: the gold set, where the filing is in it
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// One name
// ---------------------------------------------------------------------------
import { runToCompletion, abstentionsFrom } from "../lib/run/runner";
import { withGroupFollowing } from "../lib/run/stages/group";
import { buildLiveFactManifest, type BuildLiveOptions } from "../lib/sources/companiesHouseLive";
import { fixtureFromManifest } from "../lib/workspace";
import { assembleTearSheet, toCsv } from "../lib/engine/assemble";
import { buildModelWorkbook } from "../lib/model/buildWorkbook";
import type { StageEvent } from "../lib/vision/types";
import type { RunRecord } from "../lib/run/types";

const STAGE_ORDER = ["resolve", "fetch", "extract", "verify", "assemble"];

// The value checks on one manifest: provenance of every figure, the third read, the ties and
// the gold set. Used on the sheet a run produced, and on the late manifest of a run that timed
// out, whose figures never reached a sheet but still say whether the engine was slow or wrong.
async function valueChecks(
  n: number,
  m: FactManifest,
  builtNumbers: string[],
  figures: Fact[],
  tag = "",
): Promise<{ checks: CheckResult[]; thirdReadCostGbp: number }> {
  const checks: CheckResult[] = [];
  let thirdReadCostGbp = 0;
  for (const f of figures) checks.push(provenanceCheck(f, m.facts));

  const readNumber = builtNumbers[builtNumbers.length - 1];
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(join(SCRATCH, `manifest-${n}${tag}.json`), JSON.stringify(m, null, 1));
  const picks = pickThree(m.facts);
  const scanPicks = picks.filter((f) => f.provenance?.kind === "scan-read");
  const ixPicks = picks.filter((f) => f.provenance?.documentName?.includes("iXBRL"));
  const textPicks = picks.filter((f) => f.provenance?.documentName?.includes("text layer"));
  const otherPicks = picks.filter((f) => !scanPicks.includes(f) && !ixPicks.includes(f) && !textPicks.includes(f));
  let equity: { value: number; text: string } | null = null;
  const na = surfacedNumber(m.facts, "netAssets")?.fact ?? null;
  const equityFact = na?.provenance?.kind === "scan-read" ? na : null;
  if (scanPicks.length || equityFact) {
    const r = await thirdReadScan(n, readNumber, scanPicks, equityFact);
    checks.push(...r.checks);
    equity = r.equity;
    thirdReadCostGbp += r.costGbp;
  }
  if (ixPicks.length) {
    const xml = await getLatestAccountsIxbrl(readNumber).catch(() => null);
    if (xml) checks.push(...thirdReadIxbrl(xml, ixPicks));
    else checks.push(...ixPicks.map((f) => ({ check: "third-read" as const, subject: f.id, outcome: "not-run" as const, detail: "the iXBRL could not be fetched again" })));
  }
  if (textPicks.length) {
    const text = await getLatestAccountsPdfText(readNumber).catch(() => null);
    if (text) checks.push(...thirdReadText(text, textPicks));
    else checks.push(...textPicks.map((f) => ({ check: "third-read" as const, subject: f.id, outcome: "not-run" as const, detail: "the PDF text could not be fetched again" })));
  }
  for (const f of otherPicks) checks.push({ check: "third-read", subject: f.id, outcome: "not-run", detail: `no third-read route for source ${f.provenance?.documentName}` });
  if (picks.length === 0) checks.push({ check: "third-read", subject: "(none)", outcome: "not-run", detail: "no reported financial figure surfaced, so there was nothing to read a third time" });

  checks.push(...ties(m.facts, equity));
  checks.push(...goldChecks(builtNumbers, m));
  return { checks, thirdReadCostGbp };
}

async function runName(row: NameRow): Promise<NameResult> {
  usageSink = [];
  chCallsThisName = 0;
  const started = Date.now();
  const builtNumbers: string[] = [];
  const events: StageEvent[] = [];
  let pending: Promise<FactManifest> | null = null;
  const box: { manifest: FactManifest | null } = { manifest: null };

  const inner = (number: string, options: BuildLiveOptions) => {
    builtNumbers.push(number);
    const p = buildLiveFactManifest(number, {
      ...options,
      onStage: (e) => {
        events.push(e);
        options.onStage?.(e);
      },
    });
    return p;
  };
  const build = (number: string, options: BuildLiveOptions) => {
    const p = withGroupFollowing(inner)(number, options);
    pending = p;
    p.then((m) => (box.manifest = m)).catch(() => {});
    return p;
  };

  let crash: string | null = null;
  let run: RunRecord | null = null;
  let viaSuggestion = false;
  let first: RunRecord | null = null;
  try {
    run = await runToCompletion("wp-be10-harness", row.name, { build, persist: async () => {} });
    if (run.status === "needs-choice" && run.candidates?.length) {
      // A user would pick. The harness takes the resolver's own suggestion, when it made one, and
      // posts it as a new run with the number, exactly as the pick list does. It never picks for
      // itself: no suggestion, no second run.
      first = run;
      const suggested = run.candidates.find((c) => c.suggested);
      if (suggested) {
        viaSuggestion = true;
        run = await runToCompletion("wp-be10-harness", suggested.number, { build, persist: async () => {} });
      }
    }
  } catch (e) {
    crash = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  if (run && run.status === "partial" && /^The run stopped at/.test(run.reason ?? "")) crash = run.reason;
  const inBudgetManifest: FactManifest | null = box.manifest;
  const runWallMs = Date.now() - started;

  // A run that timed out left its builder working. Wait for it (one heavy job at a time), count
  // what it spent, and record what it would have produced, separately from the verdict.
  let late: NameResult["late"] = null;
  let lateThirdReadGbp = 0;
  if (pending && !inBudgetManifest) {
    const lateManifest = await Promise.race([
      (pending as Promise<FactManifest>).catch(() => null),
      new Promise<null>((r) => setTimeout(() => r(null), 360_000)),
    ]);
    if (lateManifest) {
      const lateFigures = Object.values(lateManifest.facts).filter((f) => f.rung !== "R4" && f.value !== null);
      const vc = await valueChecks(row.n, lateManifest, builtNumbers, lateFigures, "-late");
      lateThirdReadGbp = vc.thirdReadCostGbp;
      late = {
        finished: true,
        figures: lateFigures.filter((f) => typeof f.value === "number").length,
        note: "the builder finished after the run budget; these figures never reached the sheet",
        figureRecords: lateFigures.map(figureRecord),
        abstentions: abstentionsFrom(lateManifest).map((a) => ({ factId: a.factId, label: a.label, reason: a.reason })),
        checks: vc.checks,
        suspectedFabrications: vc.checks.filter((c) => c.outcome === "fail" && c.check !== "gold").map((c) => `${c.check} ${c.subject}: ${c.detail}`),
      };
    } else {
      late = { finished: false, figures: 0, note: "the builder had not finished six minutes after the budget" };
    }
  }

  const checks: CheckResult[] = [];
  let thirdReadCostGbp = 0;
  const m: FactManifest | null = inBudgetManifest && run?.status === "done" ? inBudgetManifest : null;
  const figures = m ? Object.values(m.facts).filter((f) => f.rung !== "R4" && f.value !== null) : [];
  const exportsOut = { tearSheet: false, csv: false, xlsx: false, errors: [] as string[] };

  if (m) {
    const vc = await valueChecks(row.n, m, builtNumbers, figures);
    checks.push(...vc.checks);
    thirdReadCostGbp += vc.thirdReadCostGbp;

    try {
      const sheet = assembleTearSheet(m, fixtureFromManifest(m));
      exportsOut.tearSheet = true;
      try {
        exportsOut.csv = toCsv(sheet.exportRows).length > 0;
      } catch (e) {
        exportsOut.errors.push(`csv: ${String(e).slice(0, 120)}`);
      }
      try {
        const buf = await buildModelWorkbook(sheet);
        const bytes = Buffer.from(buf as unknown as ArrayBuffer);
        exportsOut.xlsx = bytes.length > 0;
        mkdirSync(SCRATCH, { recursive: true });
        writeFileSync(join(SCRATCH, `${row.n}.xlsx`), bytes);
      } catch (e) {
        exportsOut.errors.push(`xlsx: ${String(e).slice(0, 120)}`);
      }
    } catch (e) {
      exportsOut.errors.push(`tear sheet: ${String(e).slice(0, 160)}`);
    }
  }

  const suspected = checks
    .filter((c) => c.outcome === "fail" && c.check !== "gold")
    .map((c) => `${c.check} ${c.subject}: ${c.detail}`);
  const goldFails = checks.filter((c) => c.check === "gold" && c.outcome === "fail").map((c) => `gold ${c.subject}: ${c.detail}`);

  const failReasons: string[] = [];
  if (crash) failReasons.push(`crash: ${crash}`);
  else if (!run) failReasons.push("no run record");
  else if (run.status !== "done") failReasons.push(`run ended ${run.status}: ${run.reason ?? "no reason"}`);
  failReasons.push(...suspected.map((s) => `suspected fabrication, ${s}`));
  failReasons.push(...goldFails);
  if (m && !exportsOut.tearSheet) failReasons.push("the tear sheet did not assemble");

  const stageRows = (run?.stages ?? []).map((s) => ({ stage: s.stage, status: s.status, elapsedMs: s.elapsedMs, detail: s.detail }));
  const reached = [...stageRows].reverse().find((s) => s.status === "done" || s.status === "skipped")?.stage ?? null;
  const resolveEvents = events.filter((e) => e.stage === "resolve" && e.status === "done");
  const fetchDone = events.filter((e) => e.stage === "fetch" && e.status === "done").pop();
  const abst = m ? abstentionsFrom(m) : run?.abstentions ?? [];
  const costGbp = sumGbp(usageSink);
  const res0 = first ?? run;

  return {
    n: row.n,
    name: row.name,
    reason: row.reason,
    startedAt: new Date(started).toISOString(),
    wallMs: runWallMs,
    outcome: failReasons.length === 0 ? "pass" : "fail",
    failReasons,
    crashed: crash !== null,
    crash,
    runStatus: run?.status ?? "none",
    runReason: run?.reason ?? null,
    stageReached: reached,
    stages: stageRows,
    resolution: {
      kind: res0?.status === "needs-choice" ? "needs-choice" : run?.companyNumber ? "resolved" : run?.status === "failed" ? "none-or-excluded" : "unknown",
      number: run?.companyNumber ?? null,
      name: run?.companyName ?? null,
      viaSuggestion,
      candidates: (res0?.candidates ?? []).map((c) => ({ number: c.number, name: c.name, status: (c as { status?: string }).status })),
    },
    builtNumbers,
    accountsType: m?.entity.accountsType ?? null,
    group: (m as unknown as { group?: unknown })?.group ?? null,
    filingDetail: resolveEvents.map((e) => e.detail).join(" | ") || null,
    fetchDetail: fetchDone?.detail ?? null,
    figures: figures.map(figureRecord),
    abstentions: abst.map((a) => ({ factId: a.factId, label: a.label, reason: a.reason })),
    basisAbstentions: abst.filter((a) => /company-only statement in a group filing|did not agree on the basis/.test(a.reason)).length,
    checks,
    suspectedFabrications: suspected,
    exports: exportsOut,
    costGbp,
    thirdReadCostGbp: thirdReadCostGbp + lateThirdReadGbp,
    usage: usageSink,
    chCalls: chCallsThisName,
    late,
  };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------
// Figures read from the accounts, or built from them. Register fields (SIC code, charges,
// insolvency) are not counted: a sheet with only those has no financial figure on it.
function financialCount(figs: FigureRecord[]): number {
  return figs.filter((f) => typeof f.value === "number" && f.sourceId !== null && /accounts|derived/.test(f.sourceId)).length;
}
// The stage a run reached, as the report shows it. A run that timed out left its builder working,
// and the builder's later events still landed on the stage rows, so for those the rows say
// "assemble done". The run's own reason names the stage that timed out, so that wins.
function stageShown(r: NameResult): string {
  const t = /The (\w+) stage passed its/.exec(r.runReason ?? "");
  if (r.runStatus === "partial" && t) return `timed out in ${t[1]}`;
  return r.stageReached ?? "-";
}
function gbp(x: number): string {
  return `GBP ${x.toFixed(4)}`;
}
function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}
function writeReport(results: NameResult[], stopNote: string | null): void {
  const byN = [...results].sort((a, b) => a.n - b.n);
  const adj = loadAdjudications();
  const all = loadAllResults();
  const v = new Map(byN.map((r) => [r.n, verdict(r, adj)]));
  const passed = byN.filter((r) => v.get(r.n)!.outcome === "pass").length;
  // Spend counts every attempt, re-runs included: the money was spent either way.
  const lost = unrecorded();
  const total = all.reduce((s, r) => s + r.costGbp, 0) + lost.reduce((s, x) => s + x.gbp, 0);
  const L: string[] = [];
  L.push(`# WP-BE10 harness report, ${DATE}`);
  L.push("");
  L.push(`Generated by \`scripts/validate-names.ts\` from \`eval/names/results-${DATE}.jsonl\`. The tables below are mechanical. The reading of them is in \`docs/programme/reports/WP-BE10.md\`.`);
  L.push("");
  L.push(`- Names run: **${byN.length} of ${TOTAL_NAMES}**.${byN.length < TOTAL_NAMES ? " The rest did not run, and nothing here says they would pass." : ""}`);
  L.push(`- Passed: **${passed} of ${byN.length}**. The pass mark, when all 30 have run, is ${PASS_MARK}.`);
  L.push(`- Suspected fabrications (a figure with no provenance, a failed tie, or a disagreeing third read): **${byN.reduce((s, r) => s + r.suspectedFabrications.length, 0)}** across **${byN.filter((r) => r.suspectedFabrications.length).length}** names.`);
  L.push(`- Crashes: **${byN.filter((r) => r.crashed).length}**.`);
  L.push(`- Passes with no financial figure on the sheet (every accounts line abstained): **${byN.filter((r) => v.get(r.n)!.outcome === "pass" && financialCount(r.figures) === 0).length}**. A pass here means nothing was wrong, not that anything was found.`);
  L.push(`- Spend: **${gbp(total)}** in total over ${all.length} attempts, of which ${gbp(all.reduce((s, r) => s + r.thirdReadCostGbp, 0))} was the harness's own third reads${lost.length ? `, and ${gbp(lost.reduce((s, x) => s + x.gbp, 0))} was spent by attempts killed before they wrote a result (${lost.map((x) => x.note).join(" ")})` : ""}.`);
  L.push(`- Resolution, adjudicated by hand in \`eval/names/adjudications-${DATE}.json\`: ${["right", "wrong", "unclear"].map((k) => `${byN.filter((r) => adj[String(r.n)]?.resolution === k).length} ${k}`).join(", ")}, ${byN.filter((r) => !adj[String(r.n)]).length} not yet adjudicated.`);
  const reruns = byN.filter((r) => all.filter((x) => x.n === r.n).length > 1);
  if (reruns.length) L.push(`- Re-run after the engine fix of 23 Sep (commit 8293d43): ${reruns.map((r) => `${r.n} ${r.name}, first attempt ${all.find((x) => x.n === r.n)!.outcome}`).join("; ")}. The table shows the latest attempt.`);
  if (stopNote) L.push(`- Stopped early: ${stopNote}`);
  L.push("");
  L.push("## Per name");
  L.push("");
  L.push("| # | Name | Resolved to | Right entity? | Accounts | Filing | Status | Stage | Figures (financial) | Abstained | Time | Cost | CH calls | Verdict |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of byN) {
    const res = r.resolution.number ? `${r.resolution.name} ${r.resolution.number}${r.resolution.viaSuggestion ? " (resolver's suggestion from a pick list)" : ""}${r.builtNumbers.length > 1 || (r.builtNumbers[0] && r.builtNumbers[0] !== r.resolution.number) ? `; read ${r.builtNumbers[r.builtNumbers.length - 1]}` : ""}` : r.resolution.kind;
    L.push(`| ${r.n} | ${r.name} | ${res} | ${adj[String(r.n)]?.resolution ?? "not adjudicated"} | ${r.accountsType ?? "-"} | ${(r.fetchDetail ?? "-").replace(/\|/g, "/")} | ${r.runStatus} | ${stageShown(r)} | ${r.figures.length} (${financialCount(r.figures)}) | ${r.abstentions.length} | ${secs(r.wallMs)} | ${gbp(r.costGbp)} | ${r.chCalls} | **${v.get(r.n)!.outcome}** |`);
  }
  L.push("");
  L.push("## Resolution, by hand");
  L.push("");
  const adjAll = loadAdjudications();
  for (const r of byN) {
    const a = adjAll[String(r.n)];
    if (a) L.push(`- ${r.n}. ${r.name} -> ${r.resolution.name ?? r.resolution.kind} ${r.resolution.number ?? ""}: **${a.resolution}**. ${a.note}`);
  }
  L.push("");
  L.push("## Failures, with their reasons");
  L.push("");
  for (const r of byN.filter((x) => v.get(x.n)!.outcome === "fail")) {
    L.push(`### ${r.n}. ${r.name}`);
    for (const f of v.get(r.n)!.reasons) L.push(`- ${f}`);
    L.push("");
  }
  L.push("## Value checks per name");
  L.push("");
  for (const r of byN) {
    if (!r.checks.length) continue;
    L.push(`### ${r.n}. ${r.name}`);
    const nonProv = r.checks.filter((c) => c.check !== "provenance" || c.outcome !== "pass");
    const provPass = r.checks.filter((c) => c.check === "provenance" && c.outcome === "pass").length;
    L.push(`- provenance: ${provPass} figures carry a source that supports them`);
    for (const c of nonProv) L.push(`- ${c.check} **${c.outcome}** ${c.subject}: ${c.detail.replace(/\|/g, "/")}`);
    L.push("");
  }
  L.push("## Runs that passed their budget: what the builder produced afterwards");
  L.push("");
  L.push("None of this reached a sheet, so none of it counts in a verdict. It says whether a timed-out name was slow, or slow and wrong.");
  L.push("");
  for (const r of byN.filter((x) => x.late)) {
    const lt = r.late!;
    L.push(`### ${r.n}. ${r.name}`);
    L.push(`- ${lt.note}. Figures: ${lt.figures}.${lt.checks ? "" : " (recorded before the harness checked late manifests)"}`);
    if (lt.checks) {
      const tr = lt.checks.filter((c) => c.check === "third-read");
      L.push(`- third reads: ${tr.filter((c) => c.outcome === "pass").length} agree, ${tr.filter((c) => c.outcome === "fail").length} disagree, ${tr.filter((c) => c.outcome === "not-run").length} inconclusive; ties failed: ${lt.checks.filter((c) => c.check === "tie" && c.outcome === "fail").length}; suspected fabrications: ${lt.suspectedFabrications?.length ?? 0}`);
      for (const f of lt.suspectedFabrications ?? []) L.push(`  - ${f}`);
    }
    for (const a of (lt.abstentions ?? []).slice(0, 20)) L.push(`- abstained ${a.factId}: ${a.reason.replace(/\s+/g, " ").slice(0, 200)}`);
    L.push("");
  }
  L.push("## Figures surfaced");
  L.push("");
  for (const r of byN) {
    const fin = r.figures.filter((f) => f.sourceId !== "ch-live-register" && f.unit === "GBP" && typeof f.value === "number");
    if (!fin.length) continue;
    L.push(`### ${r.n}. ${r.name}`);
    L.push("| Fact | Value | Rung | Where | Printed | Checks |");
    L.push("|---|---|---|---|---|---|");
    for (const f of fin) L.push(`| ${f.id} | ${f.value} | ${f.rung} | ${f.page ? `p${f.page}` : (f.documentName ?? "").slice(0, 40)} | ${f.printedText ?? (f.formula ?? "").slice(0, 60)} | ${f.verification}${f.tags.length ? ` ${f.tags.join(", ")}` : ""} |`);
    L.push("");
  }
  L.push("## Abstentions");
  L.push("");
  for (const r of byN) {
    if (!r.abstentions.length) continue;
    L.push(`### ${r.n}. ${r.name} (${r.abstentions.length}${r.basisAbstentions ? `, ${r.basisAbstentions} by the WP-BE18 basis check` : ""})`);
    for (const a of r.abstentions) L.push(`- ${a.factId}: ${a.reason.replace(/\s+/g, " ").slice(0, 220)}`);
    L.push("");
  }
  const ran = byN.filter((r) => r.costGbp > 0 || r.wallMs > 0);
  if (ran.length) {
    const slow = [...ran].sort((a, b) => b.wallMs - a.wallMs).slice(0, 3);
    const dear = [...ran].sort((a, b) => b.costGbp - a.costGbp).slice(0, 3);
    L.push("## Slowest and most expensive");
    L.push("");
    L.push(`- Slowest: ${slow.map((r) => `${r.name} ${secs(r.wallMs)}`).join("; ")}.`);
    L.push(`- Most expensive: ${dear.map((r) => `${r.name} ${gbp(r.costGbp)}`).join("; ")}.`);
    L.push(`- Mean time ${secs(ran.reduce((s, r) => s + r.wallMs, 0) / ran.length)}, mean cost ${gbp(total / ran.length)} per name.`);
    L.push("");
  }
  writeFileSync(REPORT, L.join("\n"));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const names = loadNames();
  if (names.length !== TOTAL_NAMES) throw new Error(`expected ${TOTAL_NAMES} names, found ${names.length}`);
  let results = loadResults();
  if (REPORT_ONLY) {
    writeReport(results, null);
    rawLog(`report written: ${REPORT}`);
    return;
  }
  const done = new Set(results.map((r) => r.n));
  let stopNote: string | null = null;
  let ranThisTime = 0;
  for (const row of names) {
    const rerun = RERUN.includes(row.n);
    if (done.has(row.n) && !rerun) continue;
    if (ONLY && !ONLY.includes(row.n) && !rerun) continue;
    if (RERUN.length && !rerun && !ONLY) continue;
    if (ranThisTime >= LIMIT) {
      stopNote = `--limit ${LIMIT} reached`;
      break;
    }
    const attempts = loadAllResults();
    const spent = attempts.reduce((s, r) => s + r.costGbp, 0) + unrecorded().reduce((s, x) => s + x.gbp, 0);
    const avg = attempts.length ? spent / attempts.length : 0;
    if (spent >= CAP_GBP || spent + avg > CAP_GBP) {
      stopNote = `the budget: ${gbp(spent)} spent over ${results.length} names, a mean of ${gbp(avg)}, against a cap of GBP ${CAP_GBP}`;
      break;
    }
    if (creditExhausted) {
      stopNote = `the Anthropic API refused for credit: ${creditExhausted}`;
      break;
    }
    rawLog(`\n[harness] ${row.n}. ${row.name} (spent so far ${gbp(spent)})`);
    const r = await runName(row);
    appendFileSync(RESULTS, JSON.stringify(r) + "\n");
    results = loadResults();
    ranThisTime++;
    rawLog(`[harness] ${row.n}. ${row.name}: ${r.outcome} ${r.runStatus} ${r.resolution.name ?? ""} ${r.resolution.number ?? ""}, ${r.figures.length} figures, ${r.abstentions.length} abstained, ${secs(r.wallMs)}, ${gbp(r.costGbp)}${r.failReasons.length ? `\n  ${r.failReasons.join("\n  ")}` : ""}`);
  }
  if (!stopNote && creditExhausted) stopNote = `the Anthropic API refused for credit: ${creditExhausted}`;
  writeReport(results, stopNote);
  rawLog(`\n[harness] report written: ${REPORT}`);
  const adj = loadAdjudications();
  const passed = results.filter((r) => verdict(r, adj).outcome === "pass").length;
  if (results.length < TOTAL_NAMES) {
    rawLog(`[harness] ${results.length} of ${TOTAL_NAMES} names have run, ${passed} passed. No verdict until all 30 have run.`);
    process.exit(3);
  }
  rawLog(`[harness] all ${TOTAL_NAMES} ran, ${passed} passed`);
  process.exit(passed >= PASS_MARK ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
