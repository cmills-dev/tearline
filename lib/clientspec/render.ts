// lib/clientspec/render.ts
// The renderer: a ClientSpec + a FactManifest in, a spec-conformed RenderedSheet out. It
// serves each field the client's house sheet asks for from the manifest's facts, honouring
// the client's own quality bar. Where a fact is missing, or where the only fact sits below
// the field's resolution floor, the renderer abstains: it shows an honest blank rather than a
// guess or a zero. A value the client would not accept is treated as not available and is
// never shown. Nothing here originates a number; it only reads and formats the facts.

import type { RenderAgainstSpec, RenderedField, RenderedSection, RenderedSheet } from "./types";
import type { ClientSpec, ClientSpecField } from "../contracts/clientSpec";
import type { Fact, FactManifest, Rung } from "../engine/types";
import { conceptForKey, sectionForKey } from "./concepts";
import type { ConceptFormat } from "./concepts";

// Resolution ladder, best to worst: R1 is best, R4 means abstain. A fact whose rung ranks
// HIGHER than a field's floor rung is below that floor and is honestly withheld.
const RUNG_RANK: Record<Rung, number> = { R1: 0, R2: 1, R3: 2, R4: 3 };

// The currency symbol a client's default maps to. An unknown default renders symbol-less
// rather than guessing one.
function currencySymbol(currencyDefault: string): string {
  switch (currencyDefault) {
    case "GBP":
      return "£";
    case "USD":
      return "$";
    case "EUR":
      return "€";
    default:
      return "";
  }
}

// Format a resolved value for display, by the field's declared format (falling back to the
// concept's default format, then to text). Currency renders in millions to one decimal, e.g.
// "£12.5m", matching the (v / 1e6).toFixed(1) convention used across the engine.
function formatFieldValue(value: number | string, format: ConceptFormat, currencyDefault: string): string {
  switch (format) {
    case "currency": {
      const v = typeof value === "number" ? value : Number(value);
      return `${currencySymbol(currencyDefault)}${(v / 1e6).toFixed(1)}m`;
    }
    case "ratio": {
      const v = typeof value === "number" ? value : Number(value);
      return `${v.toFixed(2)}x`;
    }
    case "percent": {
      const v = typeof value === "number" ? value : Number(value);
      return `${v.toFixed(1)}%`;
    }
    case "integer": {
      const v = typeof value === "number" ? value : Number(value);
      return new Intl.NumberFormat("en-GB").format(Math.round(v));
    }
    default:
      return String(value);
  }
}

// The format a field renders with: its own override, else its concept's default, else text.
function formatFor(field: ClientSpecField): ConceptFormat {
  return (field.format as ConceptFormat | undefined) ?? conceptForKey(field.key)?.format ?? "text";
}

// The primary reporting period: the period string carried by the most facts. Ties break to
// the period whose year matches the entity's latest period end, if that is derivable from the
// period string, otherwise to the lexicographically greatest period. An empty manifest yields
// an empty period, against which every field simply abstains.
function choosePrimaryPeriod(manifest: FactManifest): string {
  const counts = new Map<string, number>();
  for (const fact of Object.values(manifest.facts)) {
    // Only count facts that actually carry a value. An abstained (null) fact must not sway the
    // period choice, or a period full of R4 abstains could win and needlessly block the sheet
    // when an older period could serve every field.
    if (fact.value === null) continue;
    counts.set(fact.period, (counts.get(fact.period) ?? 0) + 1);
  }
  if (counts.size === 0) {
    // Every fact abstained: fall back to any period present so the sheet still renders (all blank).
    const anyFact = Object.values(manifest.facts)[0];
    return anyFact?.period ?? "";
  }

  let best = -1;
  const leaders: string[] = [];
  for (const [period, count] of counts) {
    if (count > best) {
      best = count;
      leaders.length = 0;
      leaders.push(period);
    } else if (count === best) {
      leaders.push(period);
    }
  }
  if (leaders.length === 1) return leaders[0];

  // Tie-break: prefer the period whose string contains the year of latestPeriodEnd.
  const latestEnd = manifest.entity.latestPeriodEnd ?? "";
  const yearMatch = latestEnd.match(/\d{4}/);
  if (yearMatch) {
    const year = yearMatch[0];
    const matched = leaders.filter((p) => p.includes(year));
    if (matched.length === 1) return matched[0];
    if (matched.length > 1) return matched.slice().sort().reverse()[0];
  }
  // Otherwise the lexicographically greatest period.
  return leaders.slice().sort().reverse()[0];
}

// Resolve a single spec field against the chosen period. Abstains honestly when no usable fact
// exists, and withholds (belowFloor) a fact whose rung sits below the field's floor.
function resolveField(field: ClientSpecField, period: string, spec: ClientSpec, manifest: FactManifest): RenderedField {
  const base: RenderedField = {
    key: field.key,
    label: field.label,
    value: null,
    rung: null,
    abstained: false,
    belowFloor: false,
  };

  const fact: Fact | undefined = period ? manifest.facts[`${field.key}.${period}`] : undefined;

  // No fact, or an abstained (null-valued) fact: an honest blank.
  if (!fact || fact.value === null) {
    return { ...base, abstained: true };
  }

  // A fact exists but its rung is worse than the client's floor: the client will not accept a
  // value below their bar, so it is withheld rather than shown.
  if (field.resolutionFloor && RUNG_RANK[fact.rung] > RUNG_RANK[field.resolutionFloor]) {
    return { ...base, abstained: true, belowFloor: true, rung: fact.rung };
  }

  // No-fabrication guard: a numeric field whose value will not coerce to a finite number (a text
  // or malformed value reaching a currency/ratio/percent/integer field) must ABSTAIN, not render
  // "£NaNm" as though it were a real figure. Only "text" fields accept a non-numeric value.
  const fmt = formatFor(field);
  const numeric = fmt === "currency" || fmt === "ratio" || fmt === "percent" || fmt === "integer";
  if (numeric) {
    const n = typeof fact.value === "number" ? fact.value : Number(fact.value);
    if (!Number.isFinite(n)) {
      return { ...base, abstained: true, rung: fact.rung, factId: fact.id };
    }
  }

  // Acceptable: render the formatted value with the fact's rung and id.
  return {
    ...base,
    value: formatFieldValue(fact.value, fmt, spec.styleTokens.currencyDefault),
    rung: fact.rung,
    factId: fact.id,
  };
}

export const renderAgainstSpec: RenderAgainstSpec = (spec, manifest) => {
  const period = choosePrimaryPeriod(manifest);

  // Resolve every field in spec order, remembering which section each belongs to.
  const resolved: { field: ClientSpecField; rendered: RenderedField; section: string }[] = spec.fields.map((field) => ({
    field,
    rendered: resolveField(field, period, spec, manifest),
    section: sectionForKey(field.key),
  }));

  // Group by section. Sections named in the skeleton come out in skeleton order; any section
  // not in the skeleton is appended in first-seen order. Empty sections are dropped.
  const bySection = new Map<string, RenderedField[]>();
  const firstSeen: string[] = [];
  for (const { rendered, section } of resolved) {
    if (!bySection.has(section)) {
      bySection.set(section, []);
      firstSeen.push(section);
    }
    bySection.get(section)!.push(rendered);
  }

  const orderedSectionNames: string[] = [];
  for (const name of spec.skeleton) {
    if (bySection.has(name) && !orderedSectionNames.includes(name)) orderedSectionNames.push(name);
  }
  for (const name of firstSeen) {
    if (!orderedSectionNames.includes(name)) orderedSectionNames.push(name);
  }

  const sections: RenderedSection[] = orderedSectionNames
    .map((title) => ({ title, fields: bySection.get(title) ?? [] }))
    .filter((s) => s.fields.length > 0);

  // A required field that could not be served (abstained or below floor) blocks the sheet.
  const blockingFields = resolved
    .filter(({ field, rendered }) => field.required && (rendered.abstained || rendered.belowFloor))
    .map(({ field }) => field.label);

  return {
    clientId: spec.clientId,
    specVersion: spec.version,
    specName: spec.name,
    entityName: manifest.entity.companyName,
    sections,
    styleTokens: spec.styleTokens,
    blocked: blockingFields.length > 0,
    blockingFields,
  };
};
