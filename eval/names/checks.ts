// eval/names/checks.ts
// The WP-BE10 value checks that need no model and no network: provenance, ties, the gold set,
// and the iXBRL and text-layer third reads given the document. Moved out of
// scripts/validate-names.ts unchanged, so the in-process harness and the HTTP harness
// (scripts/validate-names-http.ts, WP-QA04) judge a sheet by the same rules.

import type { Fact, FactManifest } from "../../lib/engine/types";
import { UK_GOLD } from "../gold/uk";

export interface FigureRecord {
  id: string;
  metric: string;
  label: string;
  period: string;
  value: number | string | null;
  unit: string;
  rung: string;
  sourceId: string | null;
  documentName: string | null;
  kind: string | null; // "scan-read" or null
  page: number | null;
  printedText: string | null;
  tags: string[];
  snippet: string | null;
  verification: string;
  formula: string | null;
}

export interface CheckResult {
  check: "provenance" | "tie" | "third-read" | "gold";
  subject: string; // fact id or identity
  outcome: "pass" | "fail" | "not-run";
  detail: string;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (c !== "\r") cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim()));
}

export function digitsOf(text: string): number | null {
  const neg = /\(.*\d.*\)/.test(text) || /^\s*[-–−]\s*[£$€]?\s*\d/.test(text);
  const m = text.replace(/[,\s]/g, "").match(/\d+(\.\d+)?/);
  if (!m) return null;
  const v = Number(m[0]);
  return neg ? -v : v;
}

export function scaleOf(caption: string | null | undefined): number | null {
  if (!caption) return null;
  const c = caption.toLowerCase().replace(/[\s'’.]/g, "");
  if (/000|thousand|£k$|gbpk$/.test(c)) return 1e3;
  if (/£m$|£mn$|gbpm$|million|£bn/.test(c)) return /bn/.test(c) ? 1e9 : 1e6;
  if (/^(£|gbp|pounds|sterling|£sterling)$/.test(c)) return 1;
  return null;
}

export function scaleFromSnippet(snippet: string | null): number | null {
  if (!snippet) return null;
  const m = /under ([^,]+?)(?:,|$)/.exec(snippet);
  return m ? scaleOf(m[1]) : null;
}

export function provenanceCheck(fact: Fact, facts: Record<string, Fact>): CheckResult {
  const bad = (detail: string): CheckResult => ({ check: "provenance", subject: fact.id, outcome: "fail", detail });
  const p = fact.provenance;
  if (!p) return bad("a value is shown with no provenance at all");
  if (!p.snippet || !p.snippet.trim()) return bad("the provenance carries no snippet");
  if (!p.sourceId) return bad("the provenance names no source");
  if (fact.rung === "R2" || p.sourceId === "derived") {
    const inputs = fact.derivation?.inputs ?? [];
    if (!fact.derivation?.formula || inputs.length === 0) return bad("a derived value with no declared formula or inputs");
    const missing = inputs.filter((i) => !facts[i] || facts[i].rung === "R4" || facts[i].value === null);
    if (missing.length) return bad(`a derived value whose inputs are not on the sheet: ${missing.join(", ")}`);
    return { check: "provenance", subject: fact.id, outcome: "pass", detail: `derived from ${inputs.join(", ")}` };
  }
  if (p.kind === "scan-read") {
    if (!p.tags?.includes("double-read")) return bad("a scan-read figure without the double-read tag");
    if (!Number.isInteger(p.page) || (p.page ?? 0) < 1) return bad("a scan-read figure with no page");
    if (!p.printedText) return bad("a scan-read figure with no printed text");
    if (typeof fact.value === "number") {
      const printed = digitsOf(p.printedText);
      const scale = scaleFromSnippet(p.snippet);
      if (printed === null) return bad(`the printed text "${p.printedText}" holds no number`);
      if (scale === null) {
        return { check: "provenance", subject: fact.id, outcome: "pass", detail: `page ${p.page}, "${p.printedText}"; scale caption not parsed by the harness, so the digits were not re-multiplied` };
      }
      const expect = Math.abs(printed * scale);
      const tol = scale / 2 + 1;
      if (Math.abs(Math.abs(fact.value) - expect) > tol) {
        return bad(`the value ${fact.value} is not the printed "${p.printedText}" times ${scale} (${expect})`);
      }
    }
    return { check: "provenance", subject: fact.id, outcome: "pass", detail: `page ${p.page}, printed "${p.printedText}"` };
  }
  return { check: "provenance", subject: fact.id, outcome: "pass", detail: `${p.sourceId}: ${p.snippet.slice(0, 100)}` };
}

export function surfacedNumber(facts: Record<string, Fact>, metric: string): { fact: Fact; value: number } | null {
  const f = Object.values(facts).find((x) => x.metric === metric && x.rung !== "R4" && typeof x.value === "number");
  return f ? { fact: f, value: f.value as number } : null;
}

export function ties(facts: Record<string, Fact>, printedEquity: { value: number; text: string } | null): CheckResult[] {
  const out: CheckResult[] = [];
  const tie = (subject: string, lhs: number | null, rhs: number | null, detail: string, tol: number) => {
    if (lhs === null || rhs === null) {
      out.push({ check: "tie", subject, outcome: "not-run", detail: `a side is not on the sheet: ${detail}` });
      return;
    }
    const ok = Math.abs(lhs - rhs) <= tol;
    out.push({ check: "tie", subject, outcome: ok ? "pass" : "fail", detail: `${detail}: ${lhs} against ${rhs}${ok ? "" : `, out by ${Math.abs(lhs - rhs)}`}` });
  };
  const v = (m: string) => surfacedNumber(facts, m)?.value ?? null;
  const TOL = 1001; // half a printed digit at £'000, plus rounding to the penny
  // Borrowings from the maturity split, where the engine built it at R2 or read it at R1.
  const within = v("borrowingsWithinOneYear");
  const after = v("borrowingsAfterOneYear");
  const borrowings = v("borrowings");
  if (borrowings !== null && within !== null && after !== null) {
    tie("borrowings = within one year + after one year", borrowings, Math.abs(within) + Math.abs(after), "total borrowings against the sum of the split", TOL);
  }
  // Net debt from its inputs.
  const cash = v("cash");
  const netDebt = v("netDebt");
  if (netDebt !== null) {
    tie("net debt = borrowings - cash", netDebt, borrowings !== null && cash !== null ? borrowings - cash : null, "net debt against borrowings less cash", TOL);
  }
  // EBITDA from its parts, where it was built.
  const ebitda = surfacedNumber(facts, "ebitda");
  if (ebitda && ebitda.fact.rung === "R2") {
    const op = v("operatingProfit");
    const da = v("depreciationAmortisation");
    tie("EBITDA = operating profit + D&A", ebitda.value, op !== null && da !== null ? op + Math.abs(da) : null, "EBITDA against its parts", TOL);
  }
  // The balance sheet: net assets against the total equity printed on the same statement.
  const netAssets = v("netAssets");
  if (netAssets !== null) {
    tie("net assets = total equity (printed)", netAssets, printedEquity?.value ?? null, printedEquity ? `total equity printed as "${printedEquity.text}"` : "total equity was not read", TOL);
  }
  // Net current position against total assets: it cannot exceed them. A sanity bound, not an identity.
  const ta = v("totalAssets");
  const ncl = v("netCurrentLiabilities");
  if (ta !== null && ncl !== null && Math.abs(ncl) > Math.abs(ta) + TOL) {
    out.push({ check: "tie", subject: "net current position within total assets", outcome: "fail", detail: `net current ${ncl} exceeds total assets ${ta}` });
  }
  return out;
}

// The order the harness picks figures to re-read. Fixed before any name ran, not tuned.
export const THIRD_READ_ORDER = [
  "turnover",
  "netAssets",
  "cash",
  "operatingProfit",
  "totalAssets",
  "profitBeforeTax",
  "borrowingsAfterOneYear",
  "currentLiabilities",
  "borrowings",
  "netInterest",
  "leaseLiabilitiesTotal", // was "leaseLiabilities", the printed total, retired in WP-BE23; same slot
  "depreciationAmortisation",
  "netCurrentLiabilities",
  "borrowingsWithinOneYear",
];

export function pickThree(facts: Record<string, Fact>): Fact[] {
  const r1 = Object.values(facts).filter(
    (f) => f.rung === "R1" && typeof f.value === "number" && f.provenance && f.provenance.sourceId !== "derived" && THIRD_READ_ORDER.includes(f.metric),
  );
  r1.sort((a, b) => THIRD_READ_ORDER.indexOf(a.metric) - THIRD_READ_ORDER.indexOf(b.metric));
  return r1.slice(0, 3);
}

// Inline XBRL: this script's own parse of the filer's tags, independent of lib/sources/ixbrl.ts.
export function thirdReadIxbrl(xml: string, picks: Fact[]): CheckResult[] {
  const contexts = new Map<string, { end: string | null; dims: boolean }>();
  const ctxRe = /<xbrli:context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/xbrli:context>/g;
  for (let m; (m = ctxRe.exec(xml)); ) {
    const body = m[2];
    const end = /<xbrli:(?:endDate|instant)>([^<]+)</.exec(body)?.[1]?.trim() ?? null;
    contexts.set(m[1], { end, dims: /xbrldi:explicitMember|xbrldi:typedMember/.test(body) });
  }
  const tags: { name: string; ctx: string; value: number }[] = [];
  const tagRe = /<ix:nonFraction\b([^>]*)>([\s\S]*?)<\/ix:nonFraction>/g;
  for (let m; (m = tagRe.exec(xml)); ) {
    const attrs = m[1];
    const a = (k: string) => new RegExp(`\\b${k}="([^"]*)"`).exec(attrs)?.[1];
    const name = a("name");
    const ctx = a("contextRef");
    if (!name || !ctx) continue;
    const text = m[2].replace(/<[^>]+>/g, "").replace(/[,\s]/g, "");
    const num = Number(text.replace(/[^0-9.]/g, "") || "0");
    const scale = Number(a("scale") ?? "0");
    const sign = a("sign") === "-" ? -1 : 1;
    tags.push({ name: name.split(":").pop()!, ctx, value: sign * num * 10 ** scale });
  }
  return picks.map((f) => {
    const snip = f.provenance!.snippet;
    const concept = /^([^\s=]+) =/.exec(snip)?.[1]?.split(":").pop() ?? null;
    const end = /period end ([0-9-]+)/.exec(snip)?.[1] ?? null;
    if (!concept) return { check: "third-read" as const, subject: f.id, outcome: "not-run" as const, detail: `the snippet names no concept: ${snip.slice(0, 80)}` };
    const hits = tags.filter((t) => t.name === concept && (!end || contexts.get(t.ctx)?.end === end));
    if (hits.length === 0) return { check: "third-read" as const, subject: f.id, outcome: "fail" as const, detail: `no ${concept} tag for period end ${end} in the filer's own document` };
    const engine = Math.abs(f.value as number);
    const match = hits.find((h) => Math.abs(Math.abs(h.value) - engine) <= 1);
    const plain = hits.filter((h) => !contexts.get(h.ctx)?.dims).map((h) => h.value);
    return {
      check: "third-read" as const,
      subject: f.id,
      outcome: match ? ("pass" as const) : ("fail" as const),
      detail: match
        ? `${concept} ${end}: the filer tagged ${match.value}${contexts.get(match.ctx)?.dims ? " (a dimensional context)" : ""}`
        : `${concept} ${end}: engine ${f.value}, the filer's tags say ${plain.length ? plain.join(" / ") : hits.map((h) => h.value).join(" / ")}`,
    };
  });
}

// PDF text layer: is the quoted line in the text, and does it hold the value?
export function thirdReadText(text: string, picks: Fact[]): CheckResult[] {
  const flat = text.replace(/\s+/g, " ");
  return picks.map((f) => {
    const line = (f.provenance!.snippet ?? "").replace(/\s+/g, " ").trim();
    if (!line || !flat.includes(line)) {
      return { check: "third-read" as const, subject: f.id, outcome: "fail" as const, detail: `the quoted line is not in the PDF text: "${line.slice(0, 100)}"` };
    }
    const nums = [...line.matchAll(/\(?[\d,]+(?:\.\d+)?\)?/g)].map((m) => Number(m[0].replace(/[(),]/g, ""))).filter((n) => n > 0);
    const engine = Math.abs(f.value as number);
    const ok = nums.some((n) => [1, 1e3, 1e6].some((s) => Math.abs(n * s - engine) <= s / 2 + 1));
    return {
      check: "third-read" as const,
      subject: f.id,
      outcome: ok ? ("pass" as const) : ("fail" as const),
      detail: ok ? `the quoted line is in the PDF text and holds ${engine} at some scale` : `the quoted line is in the text but none of its numbers ${nums.join(", ")} gives ${engine}`,
    };
  });
}

export const GOLD_KEY_TO_METRIC: Record<string, string> = {
  turnover: "turnover",
  operating_profit: "operatingProfit",
  depreciation_amortisation: "depreciationAmortisation",
  interest_payable: "netInterest",
  profit_before_tax: "profitBeforeTax",
  cash_at_bank: "cash",
  borrowings_within_one_year: "borrowingsWithinOneYear",
  borrowings_after_one_year: "borrowingsAfterOneYear",
  lease_liabilities_total: "leaseLiabilitiesTotal",
  lease_liabilities_current: "leaseLiabilitiesCurrent",
  lease_liabilities_non_current: "leaseLiabilitiesNonCurrent",
  net_assets: "netAssets",
  total_assets: "totalAssets",
  current_liabilities: "currentLiabilities",
  net_current_liabilities: "netCurrentLiabilities",
  borrowings_total: "borrowings",
};

export function goldChecks(numbers: string[], manifest: FactManifest): CheckResult[] {
  const out: CheckResult[] = [];
  const cases = UK_GOLD.filter((c) => numbers.includes(c.companyNumber));
  if (!cases.length) return out;
  const periodEnd = manifest.entity.latestPeriodEnd;
  for (const c of cases) {
    for (const g of c.figures) {
      if (g.period !== periodEnd || g.value === "ABSTAIN") continue;
      const metric = GOLD_KEY_TO_METRIC[g.metric];
      if (!metric) continue;
      const got = surfacedNumber(manifest.facts, metric);
      if (!got) {
        out.push({ check: "gold", subject: `${c.companyNumber} ${g.metric}`, outcome: "not-run", detail: "the engine abstained on a gold figure" });
        continue;
      }
      const ok = Math.abs(Math.abs(got.value) - Math.abs(g.value)) <= 1001;
      out.push({ check: "gold", subject: `${c.companyNumber} ${g.metric}`, outcome: ok ? "pass" : "fail", detail: `engine ${got.value}, gold ${g.value} (${g.status})` });
    }
  }
  return out;
}

export function figureRecord(f: Fact): FigureRecord {
  const p = f.provenance;
  return {
    id: f.id,
    metric: f.metric,
    label: f.label,
    period: f.period,
    value: f.value,
    unit: f.unit,
    rung: f.rung,
    sourceId: p?.sourceId ?? null,
    documentName: p?.documentName ?? null,
    kind: p?.kind ?? null,
    page: p?.page ?? null,
    printedText: p?.printedText ?? null,
    tags: p?.tags ?? [],
    snippet: p?.snippet ? p.snippet.slice(0, 400) : null,
    verification: f.verification.status,
    formula: f.derivation?.formula ?? null,
  };
}
