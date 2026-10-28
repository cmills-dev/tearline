// scripts/validate-names-http.ts
// WP-QA04: the 30 names through a RUNNING preview, over HTTP, as a signed-in user would.
//
//   APP_DATABASE_URL=<app_user url> npx tsx scripts/validate-names-http.ts --base http://127.0.0.1:3107 \
//     --date 2026-09-27 --mode "CH live, model off" [--limit N] [--only 1,2] [--report-only]
//
// The WP-BE10 harness (validate-names.ts) calls the run job in its own process. This one never
// touches the engine. It registers a throwaway user on the preview, POSTs each name to
// /api/run, polls GET /api/run/[id] to the end, takes the resolver's suggestion from a pick list
// exactly as BE10 does (a second POST with the number, never a pick of its own), and then:
//
//   - reads the saved sheet back from the preview's own database as app_user, under the run's
//     tenant (the tenant id comes from the auth table, which login reads before any tenant), so
//     the wall is in force for the harness too;
//   - runs the BE10 value checks that need no model and no network (eval/names/checks.ts):
//     provenance of every figure, the ties, the gold set. The third read is NOT run: a scan
//     third read is a model call, and this harness makes no Companies House call of its own. Each
//     one is recorded as not-run with that reason, never as a pass;
//   - fetches the sheet page, the model workbook and the references export over HTTP.
//
// A crash is a 5xx from the app, a request that never answered, a run that stopped with the
// runner's own "The run stopped at" line, or a run still running after six minutes. The app log
// lines written while a name ran are scanned for errors and kept with the result.
//
// The harness spends nothing: it holds no model key and makes no outside call. What the preview
// itself calls is set by how it was started (scripts/local-preview.sh), and --mode records it.
// Results append to eval/names/results-<date>.jsonl, so a killed run resumes.

import { existsSync, readFileSync, appendFileSync, writeFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { getStore } from "../lib/store/tearSheetStore";
import type { Fact, FactManifest } from "../lib/engine/types";
import {
  type CheckResult,
  type FigureRecord,
  figureRecord,
  goldChecks,
  parseCsv,
  pickThree,
  provenanceCheck,
  ties,
} from "../eval/names/checks";

const ROOT = resolve(__dirname, "..");
const argv = process.argv.slice(2);
const arg = (k: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const BASE = (arg("base") ?? "http://127.0.0.1:3107").replace(/\/$/, "");
const DATE = arg("date") ?? new Date().toISOString().slice(0, 10);
const MODE = arg("mode") ?? "unstated";
const LIMIT = arg("limit") ? Number(arg("limit")) : Infinity;
const ONLY = arg("only")?.split(",").map(Number) ?? null;
const REPORT_ONLY = argv.includes("--report-only");
const APP_LOG = arg("app-log") ?? join(homedir(), "dev/tearline-preview/app.log");
const NAMES_CSV = join(ROOT, "eval/names/validation-30.csv");
const RESULTS = join(ROOT, `eval/names/results-${DATE}.jsonl`);
const REPORT = join(ROOT, `eval/names/report-${DATE}.md`);
// Optional inputs the report renders as they are: which stage ran in which mode, and the figures
// picked for a person to check against the filing (eval/names/handcheck-<date>.json).
const HANDCHECK = join(ROOT, `eval/names/handcheck-${DATE}.json`);
interface HandCheck {
  intro: string;
  items: { company: string; filing: string; url: string; pdfPage: number; printedPage: number | null; caption: string; engine: string; printed: string; source: string }[];
  traps: string[];
}
const RUN_WAIT_MS = 360_000;
const NAMES_PER_USER = 15; // the preview allows 20 runs per desk in 10 minutes
const PASS_MARK = 25;

interface NameRow {
  n: number;
  name: string;
  reason: string;
}
interface HttpResult {
  n: number;
  name: string;
  startedAt: string;
  wallMs: number;
  mode: string;
  outcome: "pass" | "fail";
  failReasons: string[];
  crashed: boolean;
  crash: string | null;
  runId: string | null;
  runStatus: string;
  runReason: string | null;
  stages: { stage: string; status: string; elapsedMs: number | null; detail: string }[];
  resolution: { number: string | null; name: string | null; viaSuggestion: boolean; candidates: { number: string; name: string; suggested: boolean }[] };
  sheetKey: string | null;
  sheetNumber: string | null;
  accountsType: string | null;
  periodEnd: string | null;
  figures: FigureRecord[];
  financialFigures: number;
  abstentions: { factId: string; label: string; reason: string }[];
  checks: CheckResult[];
  suspectedFabrications: string[];
  exports: { page: number | null; xlsx: number | null; xlsxBytes: number; references: number | null };
  httpErrors: string[];
  appLogErrors: string[];
}

// ---------------------------------------------------------------------------
// A tiny cookie-carrying client
// ---------------------------------------------------------------------------
let cookie = "";
let email = "";
let tenantId: string | null = null;
let namesOnUser = 0;
const httpErrors: string[] = [];

async function call(path: string, init: RequestInit = {}, tries = 4): Promise<Response> {
  for (let a = 0; ; a++) {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      redirect: "manual",
      headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}), origin: BASE },
    });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) {
      const jar = new Map(cookie.split("; ").filter(Boolean).map((c) => [c.split("=")[0], c] as const));
      for (const s of set) {
        const kv = s.split(";")[0];
        jar.set(kv.split("=")[0], kv);
      }
      cookie = [...jar.values()].join("; ");
    }
    if (res.status === 429 && a < tries) {
      const wait = Number(res.headers.get("retry-after") ?? "60");
      console.log(`[qa04] 429 on ${path}, waiting ${wait} s`);
      await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
      continue;
    }
    if (res.status >= 500) httpErrors.push(`${init.method ?? "GET"} ${path} -> ${res.status}`);
    return res;
  }
}

async function newUser(): Promise<void> {
  cookie = "";
  email = `qa04-${DATE}-${Date.now().toString(36)}@preview.local`;
  const password = `qa04-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const res = await call("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`register ${email} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  tenantId = await tenantOf(email);
  namesOnUser = 0;
  console.log(`[qa04] signed up ${email}`);
}

// The auth table is walled (0015_auth_wall.sql): app_user cannot select it, only look up one
// exact email through auth_find_user, as login does. Everything after that is read under that tenant.
async function tenantOf(addr: string): Promise<string> {
  const mod = await import("postgres");
  const postgres = (mod.default ?? mod) as unknown as (u: string, o?: unknown) => {
    unsafe(q: string, p?: unknown[]): Promise<Record<string, unknown>[]>;
    end(): Promise<void>;
  };
  const sql = postgres(process.env.APP_DATABASE_URL ?? "", { max: 1, prepare: false });
  try {
    const rows = await sql.unsafe("select tenant_id from auth_find_user($1)", [addr.toLowerCase()]);
    if (!rows[0]) throw new Error(`no app_user row for ${addr}`);
    return String(rows[0].tenant_id);
  } finally {
    await sql.end();
  }
}

// ---------------------------------------------------------------------------
// One run, to its end
// ---------------------------------------------------------------------------
interface View {
  id: string;
  status: string;
  reason: string | null;
  stages: { stage: string; status: string; elapsedMs: number | null; detail: string }[];
  companyName: string | null;
  companyNumber: string | null;
  sheetKey: string | null;
  candidates: { number: string; name: string; suggested: boolean }[] | null;
  abstentions: { factId: string; label: string; reason: string }[] | null;
}
async function runOnce(input: string): Promise<{ view: View | null; crash: string | null }> {
  const post = await call("/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input }) });
  const body = (await post.json().catch(() => null)) as { id?: string; error?: string } | null;
  if (post.status !== 202 || !body?.id) return { view: null, crash: `POST /api/run answered ${post.status}: ${body?.error ?? "no body"}` };
  const until = Date.now() + RUN_WAIT_MS;
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    const res = await call(`/api/run/${body.id}`);
    if (res.status !== 200) return { view: null, crash: `GET /api/run/${body.id} answered ${res.status}` };
    const v = (await res.json()) as View;
    if (v.status !== "running") return { view: v, crash: null };
    if (Date.now() > until) return { view: v, crash: `still running after ${RUN_WAIT_MS / 1000} s` };
  }
}

function logSize(): number {
  return existsSync(APP_LOG) ? statSync(APP_LOG).size : 0;
}
function logSince(offset: number): string[] {
  if (!existsSync(APP_LOG)) return [];
  const size = statSync(APP_LOG).size;
  if (size <= offset) return [];
  const fd = openSync(APP_LOG, "r");
  const buf = Buffer.alloc(size - offset);
  readSync(fd, buf, 0, buf.length, offset);
  closeSync(fd);
  return buf
    .toString("utf8")
    .split("\n")
    .filter((l) => /\b(Error|TypeError|RangeError|Unhandled|unhandled|ECONNRESET|FATAL)\b/.test(l))
    .map((l) => l.slice(0, 300));
}

function isFinancial(f: FigureRecord): boolean {
  return typeof f.value === "number" && f.sourceId !== null && /accounts|derived/.test(f.sourceId);
}

async function runName(row: NameRow): Promise<HttpResult> {
  if (!tenantId || namesOnUser >= NAMES_PER_USER) await newUser();
  namesOnUser++;
  httpErrors.length = 0;
  const started = Date.now();
  const logAt = logSize();
  let { view, crash } = await runOnce(row.name);
  const first = view;
  let viaSuggestion = false;
  if (!crash && view?.status === "needs-choice") {
    const s = view.candidates?.find((c) => c.suggested);
    if (s) {
      viaSuggestion = true;
      namesOnUser++;
      ({ view, crash } = await runOnce(s.number));
    }
  }
  if (!crash && view?.status === "partial" && /^The run stopped at/.test(view.reason ?? "")) crash = view.reason;

  let m: FactManifest | null = null;
  const checks: CheckResult[] = [];
  const exportsOut = { page: null as number | null, xlsx: null as number | null, xlsxBytes: 0, references: null as number | null };
  if (view?.status === "done" && view.sheetKey && tenantId) {
    m = await getStore().load(tenantId, view.sheetKey);
    if (!m) crash = crash ?? `the run said done with sheet ${view.sheetKey}, and the sheet is not in the database for this tenant`;
  }
  const figures: Fact[] = m ? Object.values(m.facts).filter((f) => f.rung !== "R4" && f.value !== null) : [];
  if (m && view?.sheetKey) {
    for (const f of figures) checks.push(provenanceCheck(f, m.facts));
    const picks = pickThree(m.facts);
    for (const f of picks) {
      const route = f.provenance?.kind === "scan-read" ? "a scan third read is a model call, and model credit is off" : "this harness makes no Companies House call of its own";
      checks.push({ check: "third-read", subject: f.id, outcome: "not-run", detail: route });
    }
    if (!picks.length) checks.push({ check: "third-read", subject: "(none)", outcome: "not-run", detail: "no reported financial figure surfaced" });
    checks.push(...ties(m.facts, null));
    checks.push(...goldChecks([m.entity.companyNumber, view.companyNumber ?? ""].filter(Boolean), m));
    const key = encodeURIComponent(view.sheetKey);
    exportsOut.page = (await call(`/sheet/${key}`)).status;
    const x = await call(`/api/model/${key}`);
    exportsOut.xlsx = x.status;
    exportsOut.xlsxBytes = x.status === 200 ? (await x.arrayBuffer()).byteLength : 0;
    exportsOut.references = (await call(`/api/export/references/${key}`)).status;
  }

  const suspected = checks.filter((c) => c.outcome === "fail" && c.check !== "gold").map((c) => `${c.check} ${c.subject}: ${c.detail}`);
  const goldFails = checks.filter((c) => c.check === "gold" && c.outcome === "fail").map((c) => `gold ${c.subject}: ${c.detail}`);
  const errs = [...httpErrors];
  if (!crash && errs.length) crash = `the app answered 5xx: ${errs.join("; ")}`;
  const failReasons: string[] = [];
  if (crash) failReasons.push(`crash: ${crash}`);
  else if (!view) failReasons.push("no run record");
  else if (view.status !== "done") failReasons.push(`run ended ${view.status}: ${view.reason ?? "no reason"}`);
  failReasons.push(...suspected.map((s) => `suspected fabrication, ${s}`));
  failReasons.push(...goldFails);
  if (m && exportsOut.page !== 200) failReasons.push(`the sheet page answered ${exportsOut.page}`);
  if (m && (exportsOut.xlsx !== 200 || exportsOut.xlsxBytes === 0)) failReasons.push(`the model workbook answered ${exportsOut.xlsx}`);

  const figs = figures.map(figureRecord);
  const res0 = first ?? view;
  return {
    n: row.n,
    name: row.name,
    startedAt: new Date(started).toISOString(),
    wallMs: Date.now() - started,
    mode: MODE,
    outcome: failReasons.length ? "fail" : "pass",
    failReasons,
    crashed: crash !== null,
    crash,
    runId: view?.id ?? null,
    runStatus: view?.status ?? "none",
    runReason: view?.reason ?? null,
    stages: view?.stages ?? [],
    resolution: {
      number: view?.companyNumber ?? null,
      name: view?.companyName ?? null,
      viaSuggestion,
      candidates: (res0?.candidates ?? []).map((c) => ({ number: c.number, name: c.name, suggested: c.suggested })),
    },
    sheetKey: view?.sheetKey ?? null,
    sheetNumber: m?.entity.companyNumber ?? null,
    accountsType: m?.entity.accountsType ?? null,
    periodEnd: m?.entity.latestPeriodEnd ?? null,
    figures: figs,
    financialFigures: figs.filter(isFinancial).length,
    abstentions: (view?.abstentions ?? []).map((a) => ({ factId: a.factId, label: a.label, reason: a.reason })),
    checks,
    suspectedFabrications: suspected,
    exports: exportsOut,
    httpErrors: errs,
    appLogErrors: logSince(logAt),
  };
}

// ---------------------------------------------------------------------------
// Results and a mechanical summary (the reading is in report-<date>.md, written by hand)
// ---------------------------------------------------------------------------
function loadNames(): NameRow[] {
  return parseCsv(readFileSync(NAMES_CSV, "utf8"))
    .slice(1)
    .map((r) => ({ n: Number(r[0]), name: r[1], reason: r[2] ?? "" }));
}
function loadResults(): HttpResult[] {
  if (!existsSync(RESULTS)) return [];
  const latest = new Map<number, HttpResult>();
  for (const l of readFileSync(RESULTS, "utf8").split("\n").filter((x) => x.trim())) {
    const r = JSON.parse(l) as HttpResult;
    latest.set(r.n, r);
  }
  return [...latest.values()].sort((a, b) => a.n - b.n);
}
// The same hand adjudication BE10 uses: was the company the one the list meant? "wrong" fails the
// name. The harness cannot know it; a person who looked at the register says so in this file.
const ADJUDICATIONS = join(ROOT, `eval/names/adjudications-${DATE}.json`);
function adjudicated(r: HttpResult, adj: Record<string, { resolution: string; note: string }>): HttpResult {
  const a = adj[String(r.n)];
  if (a?.resolution !== "wrong") return r;
  return { ...r, outcome: "fail", failReasons: [...r.failReasons, `resolved to the wrong entity: ${a.note}`] };
}
function writeSummary(raw: HttpResult[]): void {
  const adj = existsSync(ADJUDICATIONS) ? JSON.parse(readFileSync(ADJUDICATIONS, "utf8")) : {};
  const results = raw.map((r) => adjudicated(r, adj));
  const L: string[] = [];
  const pass = results.filter((r) => r.outcome === "pass");
  L.push(`# WP-QA04 report, ${DATE}: the 30 names over HTTP`, "");
  L.push(`Mechanical, from \`eval/names/results-${DATE}.jsonl\` by \`scripts/validate-names-http.ts\`. Mode: ${MODE}. Base: ${BASE}.`, "");
  L.push(`- Names run: ${results.length}. Passed: ${pass.length} (bar ${PASS_MARK}). With at least one financial figure: ${pass.filter((r) => r.financialFigures > 0).length}.`);
  L.push(`- Crashes: ${results.filter((r) => r.crashed).length}. Suspected fabrications: ${results.reduce((s, r) => s + r.suspectedFabrications.length, 0)}.`);
  L.push(`- Resolution adjudicated in \`eval/names/adjudications-${DATE}.json\`: ${["right", "wrong", "unclear"].map((k) => `${results.filter((r) => adj[String(r.n)]?.resolution === k).length} ${k}`).join(", ")}. The table shows the latest attempt per name; every attempt is in the results file.`, "");
  L.push("| # | Name | Status | Resolved to | Sheet of | Accounts | Figures (financial) | Abstained | Prov. pass/fail | Ties pass/fail | Gold pass/fail | Page / xlsx / refs | Time | Verdict |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    const c = (k: string, o: string) => r.checks.filter((x) => x.check === k && x.outcome === o).length;
    const res = r.resolution.number ? `${r.resolution.name} ${r.resolution.number}${r.resolution.viaSuggestion ? " (suggestion)" : ""}` : "-";
    L.push(`| ${r.n} | ${r.name} | ${r.runStatus} | ${res} | ${r.sheetNumber ?? "-"} | ${r.accountsType ?? "-"} | ${r.figures.length} (${r.financialFigures}) | ${r.abstentions.length} | ${c("provenance", "pass")}/${c("provenance", "fail")} | ${c("tie", "pass")}/${c("tie", "fail")} | ${c("gold", "pass")}/${c("gold", "fail")} | ${r.exports.page ?? "-"} / ${r.exports.xlsx ?? "-"} / ${r.exports.references ?? "-"} | ${(r.wallMs / 1000).toFixed(1)} s | **${r.outcome}** |`);
  }
  L.push("", "## Failures", "");
  for (const r of results.filter((x) => x.outcome === "fail")) {
    L.push(`- ${r.n}. ${r.name}: ${r.failReasons.join(" / ")}`);
  }
  const attempts = existsSync(RESULTS) ? readFileSync(RESULTS, "utf8").split("\n").filter((x) => x.trim()).map((x) => JSON.parse(x) as HttpResult) : [];
  const earlier = attempts.filter((a) => a.outcome === "fail" && results.find((r) => r.n === a.n && r.startedAt !== a.startedAt));
  if (earlier.length) {
    L.push("", "## Earlier attempts that failed and were re-run", "");
    for (const a of earlier) L.push(`- ${a.n}. ${a.name}, ${a.startedAt}: ${a.failReasons.join(" / ")}`);
  }
  L.push("", "## App log errors while a name ran", "");
  const logged = results.filter((x) => x.appLogErrors.length);
  if (!logged.length) L.push("None.");
  for (const r of logged) L.push(`- ${r.n}. ${r.name}: ${r.appLogErrors.slice(0, 3).join(" | ")}`);
  if (existsSync(HANDCHECK)) {
    const h = JSON.parse(readFileSync(HANDCHECK, "utf8")) as HandCheck;
    L.push("", `## Hand check: ${h.items.length} figures for a person to tick`, "", h.intro, "");
    L.push("| # | Company | Filing | PDF page (printed) | Caption | Engine says | Printed | Source of the figure | OK? |");
    L.push("|---|---|---|---|---|---|---|---|---|");
    h.items.forEach((x, i) => L.push(`| ${i + 1} | ${x.company} | [${x.filing}](${x.url}) | ${x.pdfPage} (${x.printedPage ?? "-"}) | ${x.caption} | ${x.engine} | ${x.printed} | ${x.source} | [ ] |`));
    if (h.traps.length) L.push("", ...h.traps.map((t) => `- ${t}`));
  }
  writeFileSync(REPORT, L.join("\n") + "\n");
}

async function main(): Promise<void> {
  if (!REPORT_ONLY) {
    if (!process.env.APP_DATABASE_URL) throw new Error("APP_DATABASE_URL (the app_user URL of the preview's database) is not set");
    const health = await (await fetch(`${BASE}/api/health`)).json();
    console.log(`[qa04] preview health ${JSON.stringify(health)}`);
    if (!health.ready) throw new Error("the preview is not ready");
    const done = new Set(loadResults().map((r) => r.n));
    let ran = 0;
    for (const row of loadNames()) {
      if (ONLY ? !ONLY.includes(row.n) : done.has(row.n)) continue;
      if (ran >= LIMIT) break;
      console.log(`[qa04] ${row.n}. ${row.name}`);
      let r: HttpResult;
      try {
        r = await runName(row);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        r = {
          n: row.n, name: row.name, startedAt: new Date().toISOString(), wallMs: 0, mode: MODE, outcome: "fail",
          failReasons: [`crash: harness error ${msg}`], crashed: true, crash: `harness error ${msg}`, runId: null,
          runStatus: "none", runReason: null, stages: [], resolution: { number: null, name: null, viaSuggestion: false, candidates: [] },
          sheetKey: null, sheetNumber: null, accountsType: null, periodEnd: null, figures: [], financialFigures: 0,
          abstentions: [], checks: [], suspectedFabrications: [], exports: { page: null, xlsx: null, xlsxBytes: 0, references: null },
          httpErrors: [...httpErrors], appLogErrors: [],
        };
      }
      appendFileSync(RESULTS, JSON.stringify(r) + "\n");
      console.log(`[qa04]   ${r.outcome} ${r.runStatus} ${r.resolution.name ?? ""} ${(r.wallMs / 1000).toFixed(1)} s ${r.failReasons.join(" / ").slice(0, 200)}`);
      ran++;
    }
  }
  writeSummary(loadResults());
  console.log(`[qa04] summary written to ${REPORT}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("[qa04]", e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
