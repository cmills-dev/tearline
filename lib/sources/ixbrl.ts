// lib/sources/ixbrl.ts
// A DETERMINISTIC inline-XBRL (iXBRL) reader for UK company accounts. No model is
// involved: it reads the tagged facts a filer already placed in the accounts document
// (FRC / uk-gaap taxonomy) and returns the base financial lines with the exact concept
// and context that back each number. Everything it returns is a figure the filer
// tagged; it never derives, proxies, or invents. The resolution ladder downstream turns
// these base lines into EBITDA, net debt and leverage.
//
// Scope of this spike: the common `ix:nonFraction` monetary facts on the primary period.
// It is namespace-prefix tolerant and handles scale, sign, and thousands separators. It
// is intentionally conservative: a concept it does not recognise is left for the ladder
// to abstain on, rather than guessed. Validate against a real filing once CH_API_KEY is
// set (the connector fetches the accounts iXBRL then).

import type { FactPrecision } from "../engine/types";
import { addPrecision, precisionFromDecimals, precisionFromPrinted } from "../engine/precision";

export interface IxbrlContext {
  id: string;
  instant?: string; // YYYY-MM-DD for balance-sheet (point-in-time) facts
  startDate?: string;
  endDate?: string; // for P&L (duration) facts
  dimensioned?: boolean; // true when the context carries a segment/scenario explicit/typed member
  members?: { dimension: string; member: string }[]; // explicit members, local names (WP-BE13)
  typed?: boolean; // true when the context carries a typed member (a filer's own line item)
}

export interface IxbrlUnit {
  id: string;
  measure: string; // e.g. "iso4217:GBP"
}

export interface IxbrlFact {
  concept: string; // local name, e.g. "TurnoverRevenue"
  prefix: string; // e.g. "core"
  contextRef: string;
  unitRef?: string;
  value: number; // scale- and sign-applied
  rawText: string; // the human string the filer tagged, e.g. "12,345"
  precision?: FactPrecision; // from the decimals attribute, else the printed figure and its scale
  start?: number; // offset of the opening tag in the document, so a face line can be placed between two others
  end?: number; // offset just past the closing tag
}

export interface ParsedIxbrl {
  facts: IxbrlFact[];
  contexts: Record<string, IxbrlContext>;
  units: Record<string, IxbrlUnit>;
}

// A base financial line, ready to become an R1 Fact. `metric` is our engine key, so the
// ladder (which consumes operatingProfit, depreciationAmortisation, cash, borrowings,
// netInterest, turnover) can synthesise the derived metrics with no special-casing.
export interface ExtractedLine {
  metric: string;
  label: string;
  unit: string; // "GBP"
  value: number;
  concept: string; // the full tagged concept, e.g. "core:TurnoverRevenue"
  contextRef: string;
  periodEnd: string; // the context's end date or instant
  rawText: string;
  filedAt?: string; // the as-reported / filing date of this line, when the source supplies one (SEC)
  note?: string; // how a line summed from several tags was put together, shown with its citation
  precision?: FactPrecision; // printed precision, for the structural checks' tolerance (QA05 skip 2)
}

export interface ExtractedFinancials {
  periodEnd: string; // the primary (latest) reporting period end
  currency: string; // e.g. "GBP"
  lines: ExtractedLine[];
}

// ---------------------------------------------------------------------------
// Parsing. iXBRL is XML; we read it with prefix-tolerant patterns rather than pull in a
// DOM dependency. Adequate for well-formed accounts; a malformed document simply yields
// fewer facts (and the ladder abstains), never a wrong number.
// ---------------------------------------------------------------------------

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i"));
  return m ? m[1] : undefined;
}

function localName(qname: string): string {
  return (qname.includes(":") ? qname.split(":").pop()! : qname).toLowerCase();
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

// Turn a tagged monetary string into a number, applying thousands separators, scale and
// sign. Returns null when the text is not numeric (e.g. a nil fact).
function toNumber(rawText: string, scaleAttr?: string, signAttr?: string, formatAttr?: string): number | null {
  const trimmed = rawText.trim();
  const fmt = (formatAttr ?? "").toLowerCase();
  // Comma is the decimal separator when the ixt transform pairs it as the decimal position:
  // ixt `numcommadecimal`, ixt2 `numdotcomma` / `numspacecomma`. Otherwise the dot is the decimal,
  // and commas/spaces (incl. non-breaking) are thousands separators. Getting this wrong is a c.
  // 1000x error on a continental filing (see docs/extraction-strategy.md).
  // ixt4 spells the same transforms with hyphens (num-comma-decimal); those read as dot-decimal
  // and came out 1,000x small (WP-QA03 N7).
  const commaDecimal = /(comma-?decimal|dot-?comma|space-?comma)/.test(fmt);
  const cleaned = commaDecimal
    ? trimmed.replace(/[.\s\u00a0]/g, "").replace(/,/g, ".")
    : trimmed.replace(/[,\s\u00a0]/g, "");
  if (cleaned === "" || cleaned === "-") return null;
  // Keep digits, a single leading minus, and one decimal point.
  const normalised = cleaned.replace(/[^0-9.-]/g, "");
  const n = Number(normalised);
  if (!Number.isFinite(n)) return null;
  const scale = scaleAttr ? Number(scaleAttr) : 0;
  const scaled = Number.isFinite(scale) ? n * Math.pow(10, scale) : n;
  return signAttr === "-" ? -scaled : scaled;
}

// The precision of a tagged figure: the decimals attribute the filer declared, else the decimal
// places printed times the scale attribute. A comma-decimal format prints its decimals after the
// comma, so the text is normalised to a dot first.
function precisionOf(rawText: string, decimalsAttr?: string, scaleAttr?: string, formatAttr?: string): FactPrecision | undefined {
  const declared = precisionFromDecimals(decimalsAttr);
  if (declared) return declared;
  const commaDecimal = /(comma-?decimal|dot-?comma|space-?comma)/.test((formatAttr ?? "").toLowerCase());
  const text = commaDecimal ? rawText.replace(/[.\s\u00a0]/g, "").replace(/,/g, ".") : rawText.replace(/[,\s\u00a0]/g, "");
  const scale = scaleAttr ? Number(scaleAttr) : 0;
  return precisionFromPrinted(text, Math.pow(10, Number.isFinite(scale) ? scale : 0));
}

export function parseIxbrl(xml: string): ParsedIxbrl {
  const contexts: Record<string, IxbrlContext> = {};
  const units: Record<string, IxbrlUnit> = {};
  const facts: IxbrlFact[] = [];

  // Contexts: <...:context id="..."> ... period (instant | startDate/endDate) ... </...:context>
  const ctxRe = /<[\w-]*:?context\b([^>]*)>([\s\S]*?)<\/[\w-]*:?context>/gi;
  let cm: RegExpExecArray | null;
  while ((cm = ctxRe.exec(xml)) !== null) {
    const id = attr(cm[1], "id");
    if (!id) continue;
    const body = cm[2];
    const instant = body.match(/<[\w-]*:?instant>\s*([\d-]+)\s*<\/[\w-]*:?instant>/i)?.[1];
    const startDate = body.match(/<[\w-]*:?startDate>\s*([\d-]+)\s*<\/[\w-]*:?startDate>/i)?.[1];
    const endDate = body.match(/<[\w-]*:?endDate>\s*([\d-]+)\s*<\/[\w-]*:?endDate>/i)?.[1];
    // A context is DIMENSIONED when its segment/scenario carries an explicit or typed member (a
    // business segment, a "restated" axis, a class of shares, ...). Those facts are NOT the
    // consolidated/entity-level total, so a segment revenue must never beat the group revenue. We
    // flag them here and drop them in pickLatest, mirroring the ESEF path's "consolidated total only".
    const dimensioned = /<[\w-]*:?(?:explicitMember|typedMember)\b/i.test(body);
    const local = (s: string) => s.trim().split(":").pop() ?? "";
    const members = [...body.matchAll(/<[\w-]*:?explicitMember\b[^>]*\bdimension\s*=\s*"([^"]*)"[^>]*>([^<]*)</gi)].map((m) => ({
      dimension: local(m[1]),
      member: local(m[2]),
    }));
    const typed = /<[\w-]*:?typedMember\b/i.test(body);
    contexts[id] = { id, instant, startDate, endDate, dimensioned, members, typed };
  }

  // Units: <...:unit id="..."> ... <...:measure>iso4217:GBP</...:measure> ... </...:unit>
  const unitRe = /<[\w-]*:?unit\b([^>]*)>([\s\S]*?)<\/[\w-]*:?unit>/gi;
  let um: RegExpExecArray | null;
  while ((um = unitRe.exec(xml)) !== null) {
    const id = attr(um[1], "id");
    if (!id) continue;
    const measure = um[2].match(/<[\w-]*:?measure>\s*([^<\s]+)\s*<\/[\w-]*:?measure>/i)?.[1] ?? "";
    units[id] = { id, measure };
  }

  // Facts: <...:nonFraction ...attrs...>value</...:nonFraction>. Self-closing nil facts
  // carry no value and are skipped.
  const factRe = /<[\w-]*:?nonFraction\b([^>]*?)>([\s\S]*?)<\/[\w-]*:?nonFraction>/gi;
  let fm: RegExpExecArray | null;
  while ((fm = factRe.exec(xml)) !== null) {
    const attrs = fm[1];
    if (/\bxsi:nil\s*=\s*"true"/i.test(attrs)) continue;
    const name = attr(attrs, "name");
    const contextRef = attr(attrs, "contextRef");
    if (!name || !contextRef) continue;
    const rawText = stripTags(fm[2]).trim();
    const value = toNumber(rawText, attr(attrs, "scale"), attr(attrs, "sign"), attr(attrs, "format"));
    if (value === null) continue;
    const [prefix, local] = name.includes(":") ? name.split(":") : ["", name];
    facts.push({
      concept: local,
      prefix,
      contextRef,
      unitRef: attr(attrs, "unitRef"),
      value,
      rawText,
      precision: precisionOf(rawText, attr(attrs, "decimals"), attr(attrs, "scale"), attr(attrs, "format")),
      start: fm.index,
      end: fm.index + fm[0].length,
    });
  }

  return { facts, contexts, units };
}

// ---------------------------------------------------------------------------
// Concept mapping. FRC / uk-gaap concept local names -> our base metric keys. Matched
// case-insensitively on the local name. Kept conservative on purpose: only concepts we
// are confident about map through; anything else is left untouched so the ladder abstains.
// ---------------------------------------------------------------------------

const TURNOVER = ["turnoverrevenue", "turnover", "revenue"];
// Trading account (BE identities live), the local names 03454787 tags. FRC CostSales is tagged
// positive, the same convention the trading-account identity uses (turnover - cost of sales).
const COST_OF_SALES = ["costsales", "costofsales"];
const GROSS_PROFIT = ["grossprofitloss", "grossprofit"];
const OPERATING_PROFIT = ["operatingprofitloss", "operatingprofit"];
// The "...Expense..." forms are the FRC core names Busy Bees tags (WP-BE13); without them its
// EBITDA fell to the operating-profit proxy and leverage abstained.
const DEPRECIATION = [
  "depreciationexpense",
  "depreciationpropertyplantequipment",
  "depreciationexpensepropertyplantequipment",
  "depreciationimpairmentexpenseincludedwithincostsales",
];
const AMORTISATION = ["amortisationexpense", "amortisationintangibleassets", "amortisationexpenseintangibleassets"];
const DEPR_AMORT_COMBINED = [
  "depreciationamortisationexpense",
  "depreciationamortisationimpairmentexpense",
];
const CASH = ["cashbankonhand", "cashbankinhand", "cash", "cashcashequivalents"];
const BORROWINGS = ["bankborrowings", "borrowings", "loansborrowings", "bankloans"];
const NET_INTEREST = [
  "interestpayablesimilarchargesfinancecosts",
  "interestpayablesimilarcharges",
  "financecosts",
  "interestexpense",
];

// Balance-sheet concepts. These ARE present in filleted (FRS 102 1A) and micro (FRS 105)
// accounts, which omit the profit-and-loss account. Extracting them turns "abstain on
// everything" into real balance-sheet credit signals for the largest UK filer population.
// The Creditors maturity split reads the legacy distinct concepts first, then the current
// single-concept-plus-dimension form (CREDITORS_DIMENSIONED below). Where neither is tagged
// the split abstains rather than collapsing the two figures.
const NET_ASSETS = ["netassetsliabilities", "netassetsliabilitiesincludingpensionassetliability"];
const EQUITY = ["equity", "shareholderfunds", "capitalandreserves"];
const SHARE_CAPITAL = ["calledupsharecapital"];
// Format 1 item A, "Called up share capital not paid", shown above fixed assets. It is an asset,
// not the share capital, and it sits inside total assets less current liabilities, so the UK
// format tie adds it (BE UK format ties). It was landed as shareCapital before, which no reader used.
const SHARE_CAPITAL_NOT_PAID = ["calledupsharecapitalnotpaidnotexpressedascurrentasset"];
const FIXED_ASSETS = ["fixedassets", "totalfixedassets"];
const CURRENT_ASSETS = ["currentassets", "totalcurrentassets"];
const DEBTORS = ["debtors"];
const NET_CURRENT_ASSETS = ["netcurrentassetsliabilities"];
const TOTAL_ASSETS_LESS_CURRENT = ["totalassetslesscurrentliabilities"];
const CREDITORS_WITHIN_1Y = ["creditorsduewithinoneyear", "creditorsamountsfallingduewithinoneyear"];
const CREDITORS_AFTER_1Y = ["creditorsdueafteroneyear", "creditorsamountsfallingdueafteroneyear", "creditorsamountsfallingdueaftermorethanoneyear"];

// The current FRC form of the creditors split (BE identities live): one concept, Creditors, with
// the maturity carried on dimensions. Gold filing 03454787 tags "Creditors: amounts falling due
// within one year" as Creditors on FinancialInstrumentCurrentNon-currentDimension =
// CurrentFinancialInstruments and MaturitiesOrExpirationPeriodsDimension = WithinOneYear, in one
// context with both members and another with the first alone. A context is read only when every
// member it carries is one of the two for that side, so a creditors note row (trade creditors on
// a creditor-type axis, a restated axis) can never be taken for the balance-sheet total.
const CREDITORS_DIMENSIONED = ["creditors"];
const WITHIN_1Y_MEMBERS: Record<string, string> = {
  "financialinstrumentcurrentnon-currentdimension": "currentfinancialinstruments",
  maturitiesorexpirationperiodsdimension: "withinoneyear",
};
const AFTER_1Y_MEMBERS: Record<string, string> = {
  "financialinstrumentcurrentnon-currentdimension": "non-currentfinancialinstruments",
  maturitiesorexpirationperiodsdimension: "afteroneyear",
};

// Provisions for liabilities (BE UK format ties). The face subtotal, and the component lines a
// filer may print under it. Gold filing 03454787 prints one line, "Deferred taxation", tagged
// TaxationIncludingDeferredTaxationBalanceSheetSubtotal, and no subtotal.
const PROVISIONS_SUBTOTAL = ["provisionsforliabilitiesbalancesheetsubtotal", "provisionsforliabilities"];
const PROVISION_COMPONENTS = [
  "taxationincludingdeferredtaxationbalancesheetsubtotal",
  "deferredtaxliabilities",
  "otherprovisionsbalancesheetsubtotal",
];

// A figure printed on the face with no tag: thousands-separated, bracketed, or three digits or
// more. One- and two-digit numbers are let through as note references ("16", "17").
const UNTAGGED_FIGURE = /\d{1,3}(?:[,.]\d{3})+|\(\s*[\d,.]+\s*\)|\d{3,}/;

// Provisions, landed only when the face proves the net-assets tie complete. Between the
// current-year "Total assets less current liabilities" and "Net assets" in document order, every
// figure tagged on the balance-sheet date must be creditors after one year or provisions, and no
// figure may be printed untagged. Anything else there (a pension liability, accruals and deferred
// income, government grants, a line the reader does not know) means the terms cannot be proven
// complete, and the line is not landed, so the tie cannot run and cannot fail a correct filing.
// With no subtotal, a single component is the provisions line (03454787: deferred tax alone). Two
// components with no subtotal abstain rather than add them, since the reader never sums face lines.
function provisionsOnFace(parsed: ParsedIxbrl, xml: string): IxbrlFact | undefined {
  const talcl = pickLatest(parsed, TOTAL_ASSETS_LESS_CURRENT);
  const na = pickLatest(parsed, NET_ASSETS);
  if (!talcl || !na || talcl.end === undefined || na.start === undefined) return undefined;
  const date = endOf(parsed.contexts[talcl.contextRef]);
  if (!date || endOf(parsed.contexts[na.contextRef]) !== date || talcl.end >= na.start) return undefined;

  const between = parsed.facts.filter((f) => f.start !== undefined && f.start >= talcl.end! && f.start < na.start!);
  const subtotals: IxbrlFact[] = [];
  const components: IxbrlFact[] = [];
  const creditors: IxbrlFact[] = [];
  for (const f of between) {
    const ctx = parsed.contexts[f.contextRef];
    if (endOf(ctx) !== date) continue; // the comparative column
    const c = f.concept.toLowerCase();
    const members = ctx?.members ?? [];
    if (!ctx?.dimensioned && CREDITORS_AFTER_1Y.includes(c)) creditors.push(f);
    else if (CREDITORS_DIMENSIONED.includes(c) && !ctx?.typed && members.length > 0 &&
      members.every(({ dimension, member }) => AFTER_1Y_MEMBERS[dimension.toLowerCase()] === member.toLowerCase())) creditors.push(f);
    else if (!ctx?.dimensioned && PROVISIONS_SUBTOTAL.includes(c)) subtotals.push(f);
    else if (!ctx?.dimensioned && PROVISION_COMPONENTS.includes(c)) components.push(f);
    else return undefined;
  }
  // The tie subtracts the landed creditors line, so the face line must be that same figure.
  const landed = pickLatest(parsed, CREDITORS_AFTER_1Y) ?? pickLatestOnMembers(parsed, CREDITORS_DIMENSIONED, AFTER_1Y_MEMBERS);
  if (!landed || creditors.length === 0 || creditors.some((f) => f.value !== landed.value)) return undefined;

  const text = xml
    .slice(talcl.end, na.start)
    .replace(/<[\w-]*:?nonFraction\b[\s\S]*?<\/[\w-]*:?nonFraction>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#?\w+;/g, " ");
  if (UNTAGGED_FIGURE.test(text)) return undefined;

  if (subtotals.length > 0) return subtotals.every((f) => f.value === subtotals[0].value) ? subtotals[0] : undefined;
  return components.length === 1 ? components[0] : undefined;
}

function endOf(ctx: IxbrlContext | undefined): string {
  return ctx?.endDate ?? ctx?.instant ?? "";
}

// From all facts whose concept is in `concepts`, pick the one on the latest period. This
// selects the current year over the prior-year comparative, which shares the same tag.
// DIMENSIONED facts (a segment, a restated axis, ...) are excluded so a segment figure can never
// beat the consolidated total; if the concept is ONLY ever tagged dimensioned, we abstain (return
// undefined) rather than surface a non-total, exactly as the ESEF path does.
function pickLatest(
  parsed: ParsedIxbrl,
  concepts: string[]
): IxbrlFact | undefined {
  const wanted = new Set(concepts);
  const candidates = parsed.facts.filter(
    (f) => wanted.has(f.concept.toLowerCase()) && !parsed.contexts[f.contextRef]?.dimensioned,
  );
  if (candidates.length === 0) return undefined;
  return candidates.sort(
    (a, b) => endOf(parsed.contexts[b.contextRef]).localeCompare(endOf(parsed.contexts[a.contextRef]))
  )[0];
}

// ---------------------------------------------------------------------------
// Borrowings tagged by maturity (WP-BE13, audit finding 9). FRS 101 and FRS 102 filers rarely tag
// a borrowings total. They tag each loan line in the creditors notes with a maturity dimension:
// "Secured loans" under Non-currentFinancialInstruments, a bank loan under WithinOneYear, and so
// on. pickLatest drops every dimensioned fact, so these borrowings never reached the sheet.
//
// The rule, kept as strict as the rest of this file:
//   - Only loan concepts count. Leases, amounts owed to group undertakings, directors' and
//     shareholders' loans and preference shares are never borrowings here, as on the scan path.
//   - A fact counts only when its context carries nothing but a maturity band: current or within
//     one year, or non-current or after more than one year. A finer band (one to five years, more
//     than five) is a breakdown of those, never added to them. If only finer bands are tagged on
//     a side, the side cannot be totalled and borrowings abstain.
//   - Where a side has a tagged "Borrowings" band total, that total is used alone.
//   - The two sides are added. If one side carries no loan tag at all, it is taken as nil only when
//     the filing proves it: that side's creditors total is tagged, its tagged items add up to it
//     exactly, and none of them is a loan. A filer's own line item (a typed member) passes only when
//     it equals that side's tagged lease liability, which is what it then is. Anything else abstains.
// The sum is shown with every tag in it and the reason a side is nil, so the figure can be checked.
// ---------------------------------------------------------------------------

const LOAN_CONCEPTS = [
  "bankborrowings",
  "bankoverdrafts",
  "bankborrowingsoverdrafts",
  "bankloans",
  "loansborrowings",
  "otherremainingborrowings",
  "debentureloans",
];
const BAND_TOTAL = ["borrowings"];
const CREDITORS_TOTAL = ["creditors"];
const MATURITY_DIMENSIONS = new Set(["financialinstrumentcurrentnon-currentdimension", "maturitiesorexpirationperiodsdimension"]);
const WITHIN = new Set(["currentfinancialinstruments", "withinoneyear"]);
const AFTER = new Set(["non-currentfinancialinstruments", "afteroneyear"]);
// The creditors items a nil proof accepts, each of them not a loan. Any other creditors concept on
// the side makes the proof fail, because it might be a loan under a name this list does not know.
const NON_LOAN_CREDITORS = [
  "tradecreditorstradepayables",
  "amountsowedtogroupundertakings",
  "amountsowedtorelatedparties",
  "corporationtaxpayable",
  "taxationsocialsecuritypayable",
  "othertaxationsocialsecuritypayable",
  "othercreditors",
  "accruedliabilitiesdeferredincome",
  "accruedliabilities",
  "deferredincome",
  "furtheritemcreditorscomponenttotalcreditors", // a filer's own line; must equal the lease tag
];
// Debtors share the "current" member with creditors. These are assets and are set aside.
const ASSET_ITEM = /debtors|receivable|prepayment|owedby|accruedincome$|^cash/i;
const LEASE_BY_SIDE ={ within: "leaseliabilitiescurrentliability", after: "leaseliabilitiesnon-currentliability" } as const;
const SIDE_WORDS = { within: "within one year", after: "after more than one year" } as const;

type Side = "within" | "after";

// The maturity side a context stands for: "within", "after", "finer" for a finer band, or null
// when the context carries any other dimension or mixes sides. Typed members are reported apart.
function sideOf(ctx: IxbrlContext | undefined): Side | "finer" | null {
  if (!ctx?.members?.length) return null;
  const sides = new Set<Side | "finer">();
  for (const { dimension, member } of ctx.members) {
    if (!MATURITY_DIMENSIONS.has(dimension.toLowerCase())) return null;
    const m = member.toLowerCase();
    sides.add(WITHIN.has(m) ? "within" : AFTER.has(m) ? "after" : "finer");
  }
  return sides.size === 1 ? [...sides][0] : null;
}

const qname = (f: IxbrlFact) => `${f.prefix ? f.prefix + ":" : ""}${f.concept}`;

// One value per concept on a side. The same loan is often tagged twice, once under
// Non-currentFinancialInstruments and once under that plus AfterOneYear: equal values are one fact.
// Two different values for one concept on one side cannot be told apart, so the caller abstains.
function onePerConcept(facts: IxbrlFact[]): IxbrlFact[] | null {
  const by = new Map<string, IxbrlFact>();
  for (const f of facts) {
    const k = f.concept.toLowerCase();
    const seen = by.get(k);
    if (seen && Math.abs(seen.value - f.value) >= 0.5) return null;
    if (!seen) by.set(k, f);
  }
  return [...by.values()];
}

// The proof that a side with no loan tag holds no borrowings. Returns the sentence that says why,
// or null when the filing does not prove it.
function nilSideProof(parsed: ParsedIxbrl, instant: string, side: Side): string | null {
  const atSide = parsed.facts.filter((f) => {
    const ctx = parsed.contexts[f.contextRef];
    return ctx?.instant === instant && !ctx.startDate && sideOf(ctx) === side;
  });
  const totals = onePerConcept(atSide.filter((f) => CREDITORS_TOTAL.includes(f.concept.toLowerCase()) && !parsed.contexts[f.contextRef]?.typed));
  if (!totals || totals.length !== 1) return null;
  const total = totals[0];
  const items = atSide.filter((f) => !CREDITORS_TOTAL.includes(f.concept.toLowerCase()) && !ASSET_ITEM.test(f.concept));
  if (items.some((f) => !NON_LOAN_CREDITORS.includes(f.concept.toLowerCase()))) return null;
  const named = onePerConcept(items.filter((f) => !parsed.contexts[f.contextRef]?.typed));
  if (!named) return null;
  const ownItems = items.filter((f) => parsed.contexts[f.contextRef]?.typed);
  const lease = pickLatest(parsed, [LEASE_BY_SIDE[side]]);
  for (const f of ownItems) {
    const leaseHere = lease && parsed.contexts[lease.contextRef]?.instant === instant ? lease.value : null;
    if (leaseHere === null || Math.abs(leaseHere - f.value) >= 0.5) return null;
  }
  const all = [...named, ...ownItems];
  const sum = all.reduce((s, f) => s + f.value, 0);
  if (all.length === 0 || Math.abs(sum - total.value) >= 0.5) return null;
  return `Nothing is tagged as a loan ${SIDE_WORDS[side]}: the ${all.length} tagged items of creditors falling due ${SIDE_WORDS[side]} add up to their tagged total of ${total.rawText}, and none of them is a loan.`;
}

export function borrowingsByMaturity(parsed: ParsedIxbrl): ExtractedLine | null {
  const wanted = new Set([...LOAN_CONCEPTS, ...BAND_TOTAL]);
  const banded = parsed.facts.filter((f) => {
    const ctx = parsed.contexts[f.contextRef];
    return wanted.has(f.concept.toLowerCase()) && ctx?.instant && !ctx.typed && sideOf(ctx) !== null;
  });
  if (banded.length === 0) return null;
  const instant = banded.map((f) => parsed.contexts[f.contextRef].instant!).sort().reverse()[0];
  const here = banded.filter((f) => parsed.contexts[f.contextRef].instant === instant);
  if (here.some((f) => f.value < 0)) return null;

  const parts: { side: Side; facts: IxbrlFact[] }[] = [];
  const nilNotes: string[] = [];
  for (const side of ["within", "after"] as Side[]) {
    const onSide = here.filter((f) => sideOf(parsed.contexts[f.contextRef]) === side);
    const totals = onePerConcept(onSide.filter((f) => BAND_TOTAL.includes(f.concept.toLowerCase())));
    const loans = onePerConcept(onSide.filter((f) => LOAN_CONCEPTS.includes(f.concept.toLowerCase())));
    if (!totals || !loans) return null;
    if (totals.length === 1) {
      parts.push({ side, facts: totals });
    } else if (loans.length > 0) {
      parts.push({ side, facts: loans });
    } else {
      // Nothing on this side. Finer bands alone cannot be totalled; otherwise the side must be
      // proved nil from the creditors note.
      if (here.some((f) => sideOf(parsed.contexts[f.contextRef]) === "finer")) return null;
      const proof = nilSideProof(parsed, instant, side);
      if (!proof) return null;
      nilNotes.push(proof);
    }
  }
  if (parts.length === 0) return null;

  const facts = parts.flatMap((p) => p.facts.map((f) => ({ f, side: p.side })));
  const value = facts.reduce((s, x) => s + x.f.value, 0);
  const summed = facts.length > 1 ? "The total is the sum of the loans tagged by maturity. " : "";
  return {
    metric: "borrowings",
    label: "Total borrowings",
    unit: currencyOf(parsed, facts[0].f),
    value,
    concept: facts.map((x) => `${qname(x.f)}[${SIDE_WORDS[x.side]}]`).join(" + "),
    contextRef: facts[0].f.contextRef,
    periodEnd: instant,
    rawText: facts.map((x) => x.f.rawText).join(" + "),
    note: `${summed}${nilNotes.join(" ")}`.trim() || undefined,
    // A sum carries the summed precision of its parts, and none if any part has none (QA05 skip 2).
    precision: facts.slice(1).reduce<FactPrecision | undefined>((p, x) => addPrecision(p, x.f.precision), facts[0].f.precision),
  };
}

// The latest fact for `concepts` whose context carries only members from `allowed` (at least one).
// Every such context names the same figure, so when two share a period end they agree; if they
// ever disagree the side abstains rather than choose between them.
function pickLatestOnMembers(
  parsed: ParsedIxbrl,
  concepts: string[],
  allowed: Record<string, string>,
): IxbrlFact | undefined {
  const wanted = new Set(concepts);
  const candidates = parsed.facts.filter((f) => {
    if (!wanted.has(f.concept.toLowerCase())) return false;
    const ctx = parsed.contexts[f.contextRef];
    if (!ctx || ctx.typed) return false;
    const members = ctx.members ?? [];
    return members.length > 0 && members.every(({ dimension, member }) => allowed[dimension.toLowerCase()] === member.toLowerCase());
  });
  if (candidates.length === 0) return undefined;
  const latest = candidates.map((f) => endOf(parsed.contexts[f.contextRef])).sort().reverse()[0];
  const onLatest = candidates.filter((f) => endOf(parsed.contexts[f.contextRef]) === latest);
  return onLatest.every((f) => f.value === onLatest[0].value) ? onLatest[0] : undefined;
}

function currencyOf(parsed: ParsedIxbrl, f: IxbrlFact | undefined): string {
  if (!f?.unitRef) return "GBP";
  const measure = parsed.units[f.unitRef]?.measure ?? "";
  const iso = measure.includes(":") ? measure.split(":")[1] : measure;
  return iso || "GBP";
}

/**
 * Read the base financial lines a filer tagged in an iXBRL accounts document. Returns
 * null when the document carries no recognised monetary facts. Every returned line is a
 * figure present in the source; D&A is summed only from tagged depreciation and
 * amortisation (or a tagged combined concept), never estimated.
 */
export function extractFinancials(xml: string): ExtractedFinancials | null {
  const parsed = parseIxbrl(xml);
  if (parsed.facts.length === 0) return null;

  const lines: ExtractedLine[] = [];
  const push = (metric: string, label: string, f: IxbrlFact | undefined) => {
    if (!f) return;
    lines.push({
      metric,
      label,
      unit: currencyOf(parsed, f),
      value: f.value,
      concept: `${f.prefix ? f.prefix + ":" : ""}${f.concept}`,
      contextRef: f.contextRef,
      periodEnd: endOf(parsed.contexts[f.contextRef]),
      rawText: f.rawText,
      precision: f.precision,
    });
  };

  push("turnover", "Turnover", pickLatest(parsed, TURNOVER));
  push("operatingProfit", "Operating profit", pickLatest(parsed, OPERATING_PROFIT));
  push("cash", "Cash and cash equivalents", pickLatest(parsed, CASH));
  // An undimensioned borrowings total wins. Without one, the loans tagged by maturity band.
  const borrowingsTotal = pickLatest(parsed, BORROWINGS);
  if (borrowingsTotal) push("borrowings", "Total borrowings", borrowingsTotal);
  else {
    const byMaturity = borrowingsByMaturity(parsed);
    if (byMaturity) lines.push(byMaturity);
  }
  push("netInterest", "Interest expense", pickLatest(parsed, NET_INTEREST));
  push("costOfSales", "Cost of sales", pickLatest(parsed, COST_OF_SALES));
  push("grossProfit", "Gross profit", pickLatest(parsed, GROSS_PROFIT));

  // Balance sheet (present in filleted / micro accounts even without a P&L).
  push("netAssets", "Net assets", pickLatest(parsed, NET_ASSETS));
  push("shareholdersFunds", "Shareholders' funds (equity)", pickLatest(parsed, EQUITY));
  push("shareCapital", "Called-up share capital", pickLatest(parsed, SHARE_CAPITAL));
  push("fixedAssets", "Fixed assets", pickLatest(parsed, FIXED_ASSETS));
  push("currentAssets", "Current assets", pickLatest(parsed, CURRENT_ASSETS));
  push("debtors", "Debtors", pickLatest(parsed, DEBTORS));
  push("netCurrentAssets", "Net current assets", pickLatest(parsed, NET_CURRENT_ASSETS));
  push("totalAssetsLessCurrentLiabilities", "Total assets less current liabilities", pickLatest(parsed, TOTAL_ASSETS_LESS_CURRENT));
  push("creditorsWithinOneYear", "Creditors: within one year",
    pickLatest(parsed, CREDITORS_WITHIN_1Y) ?? pickLatestOnMembers(parsed, CREDITORS_DIMENSIONED, WITHIN_1Y_MEMBERS));
  push("creditorsAfterOneYear", "Creditors: after one year",
    pickLatest(parsed, CREDITORS_AFTER_1Y) ?? pickLatestOnMembers(parsed, CREDITORS_DIMENSIONED, AFTER_1Y_MEMBERS));
  push("shareCapitalNotPaid", "Called-up share capital not paid", pickLatest(parsed, SHARE_CAPITAL_NOT_PAID));
  push("provisionsForLiabilities", "Provisions for liabilities", provisionsOnFace(parsed, xml));

  // Depreciation and amortisation: prefer a tagged combined figure; otherwise sum tagged
  // depreciation and amortisation. Each is picked as its own latest fact and can fall in a
  // different period, so amortisation is added only when it shares depreciation's period end;
  // otherwise the anchor component alone is reported, never a cross-year sum. If neither is
  // present, the line is omitted and the ladder abstains on EBITDA rather than proxying blindly.
  const combined = pickLatest(parsed, DEPR_AMORT_COMBINED);
  if (combined) {
    push("depreciationAmortisation", "Depreciation and amortisation", combined);
  } else {
    const depr = pickLatest(parsed, DEPRECIATION);
    const amort = pickLatest(parsed, AMORTISATION);
    if (depr || amort) {
      const primary = depr ?? amort!;
      const endOfLine = (l: typeof primary) => endOf(parsed.contexts[l.contextRef]);
      const secondary = depr && amort && endOfLine(depr) === endOfLine(amort) ? amort : null;
      const value = primary.value + (secondary ? secondary.value : 0);
      const parts = [primary.concept, secondary?.concept].filter(Boolean).join(" + ");
      lines.push({
        metric: "depreciationAmortisation",
        label: "Depreciation and amortisation",
        unit: currencyOf(parsed, primary),
        value,
        concept: parts,
        contextRef: primary.contextRef,
        periodEnd: endOfLine(primary),
        rawText: secondary
          ? `${primary.rawText} + ${secondary.rawText}`
          : primary.rawText,
        precision: secondary ? addPrecision(primary.precision, secondary.precision) : primary.precision,
      });
    }
  }

  if (lines.length === 0) return null;

  const periodEnd = lines
    .map((l) => l.periodEnd)
    .filter(Boolean)
    .sort()
    .reverse()[0] ?? "";
  const currency = lines.find((l) => l.unit)?.unit ?? "GBP";

  return { periodEnd, currency, lines };
}
