// lib/engine/languagePlane.ts
// The LANGUAGE PLANE is strictly separated from the fact plane. It may only REFERENCE
// facts by id through tokens; it can never originate or alter a number. Two guards
// enforce this:
//   1) a template that contains any bare digit (a number not inside a {{...}} token)
//      is rejected before rendering, so prose cannot smuggle in a figure;
//   2) every rendered string is passed through ProseGate, so nothing dirty ships.
// No live LLM is called. Prose is assembled deterministically from these templates.

import type { Fact, FactManifest } from "./types";
import { RUNG_META } from "./types";
import { displayFor, formatExact } from "../format/format";
import { assertClean, prosegate } from "./prosegate";

// Tokens: {{value:id}} {{exact:id}} {{rung:id}} {{label:id}} {{period:id}}
const TOKEN = /\{\{(value|exact|rung|label|period):([a-zA-Z0-9_.]+)\}\}/g;

// A template may not contain a bare digit. Strip tokens, then look for [0-9].
function assertNoOriginatedNumber(template: string, context: string) {
  const stripped = template.replace(TOKEN, "");
  const m = stripped.match(/[0-9]/);
  if (m) {
    throw new Error(
      `Language plane violation in ${context}: template contains a bare digit "${m[0]}" outside a fact token. Numbers must reference a Fact.`
    );
  }
}

function tokenValue(kind: string, fact: Fact | undefined, id: string): string {
  if (!fact) {
    throw new Error(`Language plane references unknown fact id "${id}".`);
  }
  switch (kind) {
    case "value":
      return displayFor(fact);
    case "exact":
      return formatExact(fact.value, fact.unit);
    case "rung":
      return RUNG_META[fact.rung].short.toLowerCase();
    case "label":
      return fact.label;
    case "period":
      return fact.period;
    default:
      return "";
  }
}

export function renderTemplate(
  template: string,
  manifest: FactManifest,
  context: string
): string {
  assertNoOriginatedNumber(template, context);
  const rendered = template.replace(TOKEN, (_all, kind: string, id: string) =>
    tokenValue(kind, manifest.facts[id], id)
  );
  return assertClean(rendered.replace(/\s+/g, " ").trim(), context);
}

// Build the borrower narrative. Every sentence is data-driven and cites facts by id.
// The narrative branches on the resolution rung of key facts so the honest story
// (clean vs proxy-and-abstain) is told without any hand-authored number.
export function buildNarrative(manifest: FactManifest): string[] {
  const paras: string[] = [];
  const f = manifest.facts;
  const latest = latestPeriod(manifest);

  // Paragraph 1: headline position.
  const turnover = f[`turnover.${latest}`];
  const ebitda = f[`ebitda.${latest}`];
  if (turnover && turnover.rung === "R1" && ebitda && ebitda.value !== null) {
    paras.push(
      renderTemplate(
        `On {{period:turnover.${latest}}} the company reports turnover of {{value:turnover.${latest}}} and {{label:ebitda.${latest}}} of {{value:ebitda.${latest}}} ({{rung:ebitda.${latest}}}).`,
        manifest,
        "narrative.headline"
      )
    );
  } else if (ebitda && ebitda.rung === "R3") {
    paras.push(
      renderTemplate(
        `Turnover is not filed under the filleted-accounts exemption, so it is held at {{rung:turnover.${latest}}}. {{label:ebitda.${latest}}} could not be built from a split depreciation charge and is carried as a {{rung:ebitda.${latest}}}: {{value:ebitda.${latest}}}, standing in for the full measure.`,
        manifest,
        "narrative.headline.filleted"
      )
    );
  }

  // Paragraph 2: leverage and cover, honest about inherited proxy bias.
  const lev = f[`leverage.${latest}`];
  // The net debt the leverage was built on (WP-BE23): including leases where the ladder paired
  // it, else excluding leases. Naming the other beside the ratio would pair unlike figures.
  const ndMetric = lev?.derivation?.inputs.some((i) => i.startsWith("netDebtIncludingLeases.")) ? "netDebtIncludingLeases" : "netDebt";
  const netDebt = f[`${ndMetric}.${latest}`];
  if (lev && lev.value !== null && netDebt && netDebt.value !== null) {
    const biasClause =
      ebitda && ebitda.rung === "R3"
        ? ` Because the {{label:ebitda.${latest}}} input is a proxy, this ratio understates true cover and overstates leverage.`
        : "";
    paras.push(
      renderTemplate(
        `${ndMetric === "netDebtIncludingLeases" ? "Net debt including leases" : "Net debt"} stands at {{value:${ndMetric}.${latest}}} ({{rung:${ndMetric}.${latest}}}), putting leverage at {{value:leverage.${latest}}} ({{rung:leverage.${latest}}}).` +
          biasClause,
        manifest,
        "narrative.leverage"
      )
    );
  }

  // Paragraph 3: balance sheet integrity. Only for a total assets figure that is on the sheet: an
  // abstaining one has no value, renders as a dash, and ProseGate rightly refuses the sentence,
  // which took the whole tear sheet down with it (WP-BE10, Iceland Foods Group and Heart with
  // Smart, 23 Sep 2026). Most UK balance sheets print no total assets line, so this is common.
  const taFact = f[`totalAssets.${latest}`];
  const ta = taFact && taFact.rung !== "R4" && taFact.value !== null ? taFact : undefined;
  if (ta && ta.verification.status === "STRUCTURAL_PASS") {
    paras.push(
      renderTemplate(
        `The balance sheet ties: total assets of {{value:totalAssets.${latest}}} equal the sum of liabilities and equity, so the reported position passes its structural check.`,
        manifest,
        "narrative.balance"
      )
    );
  } else if (ta) {
    // The identity did NOT pass (or was never run: liabilities/equity not filed). State the figure
    // without asserting a reconciliation the verification state does not support, or the prose would
    // claim a check that failed.
    paras.push(
      renderTemplate(
        `Total assets of {{value:totalAssets.${latest}}} are reported on the filed balance sheet.`,
        manifest,
        "narrative.balance.plain"
      )
    );
  }

  return paras;
}

function latestPeriod(manifest: FactManifest): string {
  const periods = new Set(Object.values(manifest.facts).map((f) => f.period));
  if (periods.size === 0) return "";
  // Prefer the period matching the entity's declared latest reporting end (FY{year}). This is the
  // same period the isLatest tiles select, so the present-tense prose never describes a prior year
  // while the tiles show the current one. (The old heuristic - the period with the MOST facts -
  // could pick a comparative year that happened to carry more tagged lines.)
  const end = manifest.entity.latestPeriodEnd;
  if (end && end.length >= 4) {
    const fyKey = `FY${end.slice(0, 4)}`;
    if (periods.has(fyKey)) return fyKey;
  }
  // Otherwise the lexically greatest FY-style key (FY2024 > FY2023).
  const fyKeys = [...periods].filter((p) => /^FY\d{4}$/.test(p)).sort();
  if (fyKeys.length) return fyKeys[fyKeys.length - 1];
  // Last resort (non-FY period labels): the period with the most facts.
  const counts: Record<string, number> = {};
  for (const fact of Object.values(manifest.facts)) {
    counts[fact.period] = (counts[fact.period] ?? 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

// Exposed so a caller can assert the whole narrative is clean in one shot.
export function narrativeIsClean(paras: string[]): boolean {
  return paras.every((p) => prosegate(p).clean);
}
