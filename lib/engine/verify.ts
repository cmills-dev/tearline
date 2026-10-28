// lib/engine/verify.ts
// Verification. Honest labels only: a single unchecked source is never called
// "verified". Where two or more reported figures let us test an accounting identity,
// we run it and record the arithmetic. A pass upgrades the fact's verification state
// to STRUCTURAL_PASS; a failure is surfaced (STRUCTURAL_FAIL), never hidden.

import type { Fact, VerificationCheck } from "./types";
import { scanReadAdmissible } from "./types";

const TOL_ABS = 1; // absolute rounding tolerance (whole currency units)
const TOL_REL = 0.005; // 0.5% relative tolerance, the fallback when a figure's precision is unknown
const TOL_FLOAT = 0.005; // half a penny, so a float sum of scaled figures never fails on representation

// The flat tolerance: a fixed rounding slack, or 0.5% of the larger magnitude, whichever is
// bigger. Without this an identity on SEC data (absolute USD, billions) would fail on
// sub-percent rounding while the same code holds on whole-pound fixtures. It is what every
// check used before QA05 skip 2, and what a check still uses when any input has no precision.
function flatTol(values: number[]): number {
  const scale = Math.max(0, ...values.map((v) => Math.abs(v)));
  return Math.max(TOL_ABS, scale * TOL_REL);
}

// The tolerance for a check over these facts (QA05 skip 2). When every input carries its printed
// precision, each may be out by half its last printed digit, so the check may be out by the sum
// of those halves and no more. £9m on £2bn printed in £m then fails, where 0.5% let it pass.
// When any input's precision was only inferred from its value, that sum can over-state the true
// rounding, so it is also capped at the flat tolerance: an inferred precision never loosens a check.
// When any input has no precision at all, the flat tolerance applies unchanged.
function tol(facts: Record<string, Fact>, ids: string[]): number {
  const values: number[] = [];
  let halves = 0;
  let known = true;
  let inferred = false;
  for (const id of ids) {
    const f = facts[id];
    if (!f || typeof f.value !== "number") continue;
    values.push(f.value);
    if (!f.precision) known = false;
    else {
      halves += f.precision.unit / 2;
      if (f.precision.basis === "value") inferred = true;
    }
  }
  const flat = flatTol(values);
  if (!known || values.length === 0) return flat;
  const printed = Math.max(TOL_ABS, halves) + TOL_FLOAT;
  return inferred ? Math.min(printed, flat) : printed;
}

function val(facts: Record<string, Fact>, metric: string, period: string): number | null {
  const f = facts[`${metric}.${period}`];
  return f && typeof f.value === "number" ? (f.value as number) : null;
}

// The equity fact for a period. Filed accounts and the SEC/ESEF mappers land it as totalEquity.
// The live UK iXBRL reader lands the FRC Equity concept as shareholdersFunds, so without this the
// equity identities never ran on a real Companies House filing (BE identities live). totalEquity
// wins when both are present. Returns the key so the check attaches to the fact actually used.
function equityKey(facts: Record<string, Fact>, period: string): string | null {
  for (const metric of ["totalEquity", "shareholdersFunds"]) {
    if (val(facts, metric, period) !== null) return `${metric}.${period}`;
  }
  return null;
}

// A sanity bound is not an accounting identity, so a PASS is only weak evidence and must
// not upgrade a fact to "verified". A FAIL, however, is a real defect (a scale misread or
// sign flip) and is surfaced as STRUCTURAL_FAIL. These catch the two errors the research
// flags as most dangerous: a 1,000x scale error and a lost negative sign.
function runSanityChecks(facts: Record<string, Fact>, period: string): VerificationCheck[] {
  const checks: VerificationCheck[] = [];
  const push = (
    id: string,
    label: string,
    identity: string,
    passed: boolean,
    detail: string,
    ids: string[],
  ) => {
    const check: VerificationCheck = { id: `${id}.${period}`, label, identity, passed, detail };
    checks.push(check);
    attach(facts, ids, check, "sanity");
  };

  const to = val(facts, "turnover", period);
  const op = val(facts, "operatingProfit", period);
  const da = val(facts, "depreciationAmortisation", period);
  const cash = val(facts, "cash", period);
  const debt = val(facts, "borrowings", period);

  // Scale guard: operating profit cannot exceed turnover (a 1,000x misread of either
  // trips this immediately). Small slack for rounding / unusual one-offs.
  if (to !== null && op !== null && to > 0) {
    const passed = op <= to + tol(facts, [`turnover.${period}`]);
    push(
      "scale-operating-margin",
      "Scale check",
      "operating profit <= turnover",
      passed,
      `${op.toLocaleString("en-GB")} ${passed ? "<=" : ">"} ${to.toLocaleString("en-GB")}`,
      [`operatingProfit.${period}`, `turnover.${period}`],
    );
    // D&A should also sit within turnover (another scale tripwire).
    if (da !== null) {
      const daOk = da >= -tol(facts, [`depreciationAmortisation.${period}`]) && da <= to + tol(facts, [`turnover.${period}`]);
      push(
        "scale-da",
        "Scale check",
        "0 <= depreciation & amortisation <= turnover",
        daOk,
        `${da.toLocaleString("en-GB")} within [0, ${to.toLocaleString("en-GB")}]`,
        [`depreciationAmortisation.${period}`],
      );
    }
  }

  // Sign checks: reported cash and borrowings are stock figures and cannot be negative.
  if (cash !== null) {
    const ok = cash >= -tol(facts, [`cash.${period}`]);
    push("sign-cash", "Sign check", "cash >= 0", ok, `cash = ${cash.toLocaleString("en-GB")}`, [
      `cash.${period}`,
    ]);
  }
  if (debt !== null) {
    const ok = debt >= -tol(facts, [`borrowings.${period}`]);
    push("sign-debt", "Sign check", "borrowings >= 0", ok, `borrowings = ${debt.toLocaleString("en-GB")}`, [
      `borrowings.${period}`,
    ]);
  }

  return checks;
}

// Run cross-field identities for a period and attach results to the relevant facts.
// Returns the list of checks run (for a manifest-level verification summary).
// The rung rule for figures read off a scan (WP-BE05), enforced where every landed fact passes.
// A scan-read fact that holds a value without the "double-read" tag, a page and its printed text
// is a single read, and is turned into an R4 abstention that says so. Returns the ids it
// abstained. Nothing upstream should ever produce one; this is the last line, not the first.
export function enforceScanReadRule(facts: Record<string, Fact>): string[] {
  const abstained: string[] = [];
  for (const [id, f] of Object.entries(facts)) {
    if (f.value === null || scanReadAdmissible(f.provenance)) continue;
    facts[id] = {
      ...f,
      value: null,
      rung: "R4",
      provenance: null,
      verification: { status: "NOT_APPLICABLE", checks: [] },
      attemptLog: [
        ...(f.attemptLog ?? []),
        {
          step: "R4 abstain",
          outcome: "insufficient",
          detail: "Read off a scanned page by one read only, with no second read agreeing. A single read is never shown.",
        },
      ],
    };
    abstained.push(id);
  }
  return abstained;
}

export function runStructuralChecks(
  facts: Record<string, Fact>,
  period: string
): VerificationCheck[] {
  const checks: VerificationCheck[] = [];
  enforceScanReadRule(facts);

  // Identity 1: balance sheet. total assets = total liabilities + total equity.
  const ta = val(facts, "totalAssets", period);
  const tl = val(facts, "totalLiabilities", period);
  const eqKey = equityKey(facts, period);
  const te = eqKey ? (facts[eqKey].value as number) : null;
  if (ta !== null && tl !== null && te !== null && eqKey) {
    const passed = Math.abs(ta - (tl + te)) <= tol(facts, [`totalAssets.${period}`, `totalLiabilities.${period}`, eqKey]);
    const check: VerificationCheck = {
      id: `balance-sheet.${period}`,
      label: "Balance sheet identity",
      identity: "total assets = total liabilities + total equity",
      passed,
      detail: `${ta.toLocaleString("en-GB")} ${passed ? "=" : "≠"} ${tl.toLocaleString(
        "en-GB"
      )} + ${te.toLocaleString("en-GB")} (= ${(tl + te).toLocaleString("en-GB")})`,
    };
    checks.push(check);
    attach(facts, [`totalAssets.${period}`, `totalLiabilities.${period}`, eqKey], check);
  }

  // Identity 2: net assets = total equity (companies-house style net-assets line).
  const na = val(facts, "netAssets", period);
  if (na !== null && te !== null && eqKey) {
    const passed = Math.abs(na - te) <= tol(facts, [`netAssets.${period}`, eqKey]);
    const check: VerificationCheck = {
      id: `net-assets.${period}`,
      label: "Net assets identity",
      identity: "net assets = total equity (shareholders' funds)",
      passed,
      detail: `${na.toLocaleString("en-GB")} ${passed ? "=" : "≠"} ${te.toLocaleString("en-GB")}`,
    };
    checks.push(check);
    attach(facts, [`netAssets.${period}`, eqKey], check);
  }

  // Identity 3: gross profit consistency. turnover - cost of sales = gross profit.
  const to = val(facts, "turnover", period);
  const cos = val(facts, "costOfSales", period);
  const gp = val(facts, "grossProfit", period);
  if (to !== null && cos !== null && gp !== null) {
    const passed = Math.abs(to - cos - gp) <= tol(facts, [`turnover.${period}`, `costOfSales.${period}`, `grossProfit.${period}`]);
    const check: VerificationCheck = {
      id: `gross-profit.${period}`,
      label: "Trading account identity",
      identity: "turnover − cost of sales = gross profit",
      passed,
      detail: `${to.toLocaleString("en-GB")} − ${cos.toLocaleString(
        "en-GB"
      )} = ${(to - cos).toLocaleString("en-GB")} vs reported ${gp.toLocaleString("en-GB")}`,
    };
    checks.push(check);
    attach(facts, [`turnover.${period}`, `costOfSales.${period}`, `grossProfit.${period}`], check);
  }

  // Identity 4: net current assets = current assets - creditors due within one year.
  // Holds for filleted / micro balance sheets, where this is often the only testable tie.
  const ca = val(facts, "currentAssets", period);
  const cw = val(facts, "creditorsWithinOneYear", period);
  const nca = val(facts, "netCurrentAssets", period);
  if (ca !== null && cw !== null && nca !== null) {
    const passed = Math.abs(ca - cw - nca) <= tol(facts, [`currentAssets.${period}`, `creditorsWithinOneYear.${period}`, `netCurrentAssets.${period}`]);
    const check: VerificationCheck = {
      id: `net-current-assets.${period}`,
      label: "Working-capital identity",
      identity: "current assets − creditors within one year = net current assets",
      passed,
      detail: `${ca.toLocaleString("en-GB")} − ${cw.toLocaleString("en-GB")} = ${(ca - cw).toLocaleString("en-GB")} vs reported ${nca.toLocaleString("en-GB")}`,
    };
    checks.push(check);
    attach(facts, [`currentAssets.${period}`, `creditorsWithinOneYear.${period}`, `netCurrentAssets.${period}`], check);
  }

  // Identity 5: the Companies Act format 1 balance sheet (BE UK format ties). UK accounts do not
  // print or tag total assets or total liabilities, so identity 1 never runs on them. Their own
  // vertical subtotals tie instead: fixed assets + net current assets = total assets less current
  // liabilities, plus item A (called up share capital not paid) when the filer shows it. Holds on
  // filleted and micro balance sheets too. Net current assets carries its sign (a net current
  // liability is negative).
  const fa = val(facts, "fixedAssets", period);
  const talcl = val(facts, "totalAssetsLessCurrentLiabilities", period);
  const unpaid = val(facts, "shareCapitalNotPaid", period);
  if (fa !== null && nca !== null && talcl !== null) {
    const ids = [`fixedAssets.${period}`, `netCurrentAssets.${period}`, `totalAssetsLessCurrentLiabilities.${period}`];
    if (unpaid !== null) ids.push(`shareCapitalNotPaid.${period}`);
    const sum = fa + nca + (unpaid ?? 0);
    const passed = Math.abs(sum - talcl) <= tol(facts, ids);
    const check: VerificationCheck = {
      id: `uk-balance-sheet.${period}`,
      label: "Balance sheet (UK format) identity",
      identity: unpaid !== null
        ? "called up share capital not paid + fixed assets + net current assets = total assets less current liabilities"
        : "fixed assets + net current assets = total assets less current liabilities",
      passed,
      detail: `${unpaid !== null ? `${unpaid.toLocaleString("en-GB")} + ` : ""}${fa.toLocaleString("en-GB")} + ${nca.toLocaleString(
        "en-GB"
      )} = ${sum.toLocaleString("en-GB")} vs reported ${talcl.toLocaleString("en-GB")}`,
    };
    checks.push(check);
    attach(facts, ids, check);
  }

  // Identity 6: format 1 below the line. Total assets less current liabilities − creditors after
  // one year − provisions = net assets. The reader lands provisionsForLiabilities only when the
  // face shows no other line between the two subtotals (lib/sources/ixbrl.ts, provisionsOnFace),
  // so a pension liability or accruals line can never make a correct filing fail. With no
  // provisions line landed the tie does not run.
  const cao = val(facts, "creditorsAfterOneYear", period);
  const prov = val(facts, "provisionsForLiabilities", period);
  if (talcl !== null && cao !== null && prov !== null && na !== null) {
    const ids = [
      `totalAssetsLessCurrentLiabilities.${period}`,
      `creditorsAfterOneYear.${period}`,
      `provisionsForLiabilities.${period}`,
      `netAssets.${period}`,
    ];
    const net = talcl - cao - prov;
    const passed = Math.abs(net - na) <= tol(facts, ids);
    const check: VerificationCheck = {
      id: `uk-net-assets.${period}`,
      label: "Net assets (UK format) identity",
      identity: "total assets less current liabilities − creditors after one year − provisions = net assets",
      passed,
      detail: `${talcl.toLocaleString("en-GB")} − ${cao.toLocaleString("en-GB")} − ${prov.toLocaleString(
        "en-GB"
      )} = ${net.toLocaleString("en-GB")} vs reported ${na.toLocaleString("en-GB")}`,
    };
    checks.push(check);
    attach(facts, ids, check);
  }

  // Scale and sign sanity checks (apply to the base metrics the live sources extract).
  checks.push(...runSanityChecks(facts, period));

  return checks;
}

// Attach a check to each participating fact and update its verification state.
// identity mode: a PASS upgrades an R1 single-source fact to STRUCTURAL_PASS. sanity
// mode: a PASS is only weak evidence and does not upgrade. In both modes a FAIL is a real
// defect surfaced as STRUCTURAL_FAIL. A DERIVED label is never overwritten by a pass.
function attach(
  facts: Record<string, Fact>,
  ids: string[],
  check: VerificationCheck,
  mode: "identity" | "sanity" = "identity",
) {
  for (const id of ids) {
    const f = facts[id];
    if (!f) continue;
    f.verification.checks.push(check);
    if (!check.passed) {
      f.verification.status = "STRUCTURAL_FAIL";
    } else if (mode === "identity" && f.verification.status === "SINGLE_SOURCE") {
      f.verification.status = "STRUCTURAL_PASS";
    }
  }
}
