// test/figureBasis.test.ts
// The per-figure basis label (WP-BE19, adversarial review 21 Sep, finding 3). WP-BE12 labels a
// subsidiary's sheet as its parent group's; this proves every figure on it says so by itself,
// that an audit-exempt company's own figures say they are unaudited, and that the two are never
// mixed on one sheet.
//
// The sheets here are built by the real mapper (mapLiveToManifest) from recorded register reads
// of the Pret chain (test/fixtures/group/, recorded 22 Sep) and from vision lines produced by the
// real WP-BE18 verifier, whose second read is scripted. No test calls a model or the network.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { suite, test, assert, assertEqual } from "./harness";
import { RecordedGroupClient, recorded } from "./group.test";
import { firstRead, found, verifyAndMap, GROUP_SEEN } from "./basisCheck.test";
import { withGroupFollowing, type Builder, type GroupManifest } from "../lib/run/stages/group";
import { mapLiveToManifest } from "../lib/sources/companiesHouseLive";
import type { VisionLines } from "../lib/sources/visionAccounts";
import { selectLatestAccountsFiling } from "../lib/resolve/filings";
import type { ChFilingItem, ChProfile } from "../lib/resolve/types";
import { BASIS_ABSTAIN } from "../lib/vision/verify";
import {
  DERIVED_BASIS_ABSTAIN,
  MIXED_BASIS_ABSTAIN,
  UNLABELLED_ABSTAIN,
  auditExemption,
  basisFor,
  labelFigures,
  type SheetOf,
} from "../lib/engine/figureBasis";
import { buildManifest } from "../lib/engine/buildManifest";
import { FIXTURES } from "../lib/sources/fixtures";
import type { Fact, FactManifest } from "../lib/engine/types";

const HERE = dirname(fileURLToPath(import.meta.url));

const PRET = "11391321"; // PRET A MANGER LIMITED, audit-exempt subsidiary
const PARENT = "13383544"; // PRET PARENT HOLDING LIMITED, group accounts

// --- A real mapper over recorded register reads --------------------------------------------

type VisionFor = (number: string) => Promise<VisionLines | null>;

// Stands in for buildLiveFactManifest with the same mapper it uses: the recorded profile, no
// charges, the latest accounts filing, and the vision lines the test supplies for that number.
function mappedBuilder(visionFor: VisionFor, builtFor: string[] = [], extra?: (m: FactManifest) => void): Builder {
  return async (number) => {
    builtFor.push(number);
    const profile = recorded<ChProfile>(`profile-${number}.json`)!;
    const filing = selectLatestAccountsFiling(recorded<{ items?: ChFilingItem[] }>(`filings-${number}.json`)?.items ?? []);
    const m = mapLiveToManifest(profile as never, { items: [] } as never, { vision: await visionFor(number), filing });
    extra?.(m);
    return m;
  };
}

// Two group figures, both agreed by both reads under consolidated headings.
async function groupLines(): Promise<VisionLines> {
  const read = firstRead("consolidated", {
    net_assets: found(20, "(42.1)", "Consolidated balance sheet", "Net liabilities"),
    turnover: found(18, "1,120.4", "Consolidated income statement", "Revenue"),
  });
  return (await verifyAndMap(read, { turnover: { basis: "consolidated", basisText: "Consolidated income statement" } }, GROUP_SEEN, "group")).mapped;
}

// The subsidiary's own audit-exempt accounts: a full accounts read, no basis question.
async function ownLines(): Promise<VisionLines> {
  const read = firstRead("company", {
    turnover: found(18, "812.6", "Income statement", "Revenue"),
    net_assets: found(20, "96.3", "Balance sheet", "Net assets"),
  });
  return (await verifyAndMap(read, {}, { basis: "none", basisText: "" }, "audit-exempt subsidiary")).mapped;
}

async function sheet(number: string, visionFor: VisionFor, routes?: ("psc" | "gleif")[], extra?: (m: FactManifest) => void) {
  const builtFor: string[] = [];
  const build = withGroupFollowing(mappedBuilder(visionFor, builtFor, extra), {
    client: new RecordedGroupClient(),
    follow: routes ? { routes } : undefined,
  });
  const m = (await build(number, {})) as GroupManifest;
  return { m, builtFor };
}

const heldFacts = (m: FactManifest) => Object.values(m.facts).filter((f) => f.value !== null && f.rung !== "R4");
const byMetric = (m: FactManifest, metric: string) => Object.values(m.facts).find((f) => f.metric === metric)!;
const lastLog = (f: Fact) => f.attemptLog?.[f.attemptLog.length - 1]?.detail ?? "";

// --- What the register's accounts type establishes ------------------------------------------

suite("figure basis / what the accounts type says about audit");

test("the audit exemptions the register names, and the types that name none", () => {
  assert(auditExemption("audit-exempt subsidiary")!.includes("section 479A"), "479A");
  assert(auditExemption("total exemption full")!.includes("section 477"), "477, full");
  assert(auditExemption("total exemption small")!.includes("section 477"), "477, small");
  assert(auditExemption("dormant")!.includes("section 480"), "480");
  assert(auditExemption("unaudited abridged")!.includes("unaudited"), "unaudited abridged");
  for (const t of ["full", "group", "small", "medium", "micro-entity", "abridged", "unknown"]) {
    assertEqual(auditExemption(t), null, `${t} establishes nothing about audit`);
  }
});

test("no label ever calls a figure audited", () => {
  const types = ["audit-exempt subsidiary", "full", "small", "micro-entity", "dormant", "group"] as const;
  for (const accountsType of types) {
    for (const from of ["accounts", "register", "derived"] as const) {
      const b = basisFor({ kind: "own", entity: { number: "1", name: "X LTD" }, accountsType, filing: null, parentNote: null }, from);
      assert(!/(^|[^n])audited/i.test(b.text), `${accountsType}/${from}: ${b.text}`);
      assert(b.audit !== ("audited" as never), "never audited");
    }
  }
});

// --- Sheet 1: every figure comes from the parent ---------------------------------------------

suite("figure basis / a parent-group sheet: every figure says it is the parent group's");

test("Pret A Manger Limited: every figure the sheet holds names Pret Parent Holding's group filing", async () => {
  const { m, builtFor } = await sheet(PRET, async (n) => (n === PARENT ? groupLines() : null));
  assertEqual(builtFor.join(","), PARENT, "built from the parent only");
  assertEqual(m.group?.basis, "parent-group", "the sheet is the parent group's");
  const g = m.group!;
  if (g.basis !== "parent-group") return;
  const held = heldFacts(m);
  assert(held.length >= 3, `the sheet holds figures and register facts (${held.length})`);
  for (const f of held) {
    const b = f.provenance!.basis;
    assert(b, `${f.id} carries a label`);
    assertEqual(b!.kind, "parent-group", `${f.id} kind`);
    assertEqual(b!.entity.number, PARENT, `${f.id} is the parent's`);
    assertEqual(b!.subject.number, PRET, `${f.id} names the subsidiary asked for`);
    assert(b!.text.includes("not PRET A MANGER LIMITED's own"), `${f.id}: ${b!.text}`);
  }
  const turnover = byMetric(m, "turnover");
  const b = turnover.provenance!.basis!;
  assertEqual(b.from, "accounts", "an accounts figure");
  assert(b.filing.includes(g.parent.filing.transactionId), `names the filing's transaction: ${b.filing}`);
  assert(b.text.includes("group accounts of PRET PARENT HOLDING LIMITED 13383544"), b.text);
  assertEqual(g.unlabelled, undefined, "nothing abstained on basis");
});

test("the parent's register facts say they are the parent's register entry, not its accounts", async () => {
  const { m } = await sheet(PRET, async (n) => (n === PARENT ? groupLines() : null));
  const reg = heldFacts(m).filter((f) => f.provenance!.tag === "Reg");
  assert(reg.length > 0, "register facts present");
  for (const f of reg) {
    assertEqual(f.provenance!.basis!.from, "register", f.id);
    assert(f.provenance!.basis!.text.startsWith("Parent group register entry"), f.provenance!.basis!.text);
  }
});

test("an abstained figure on the parent sheet carries no label", async () => {
  const { m } = await sheet(PRET, async (n) => (n === PARENT ? groupLines() : null));
  const gaps = Object.values(m.facts).filter((f) => f.rung === "R4");
  assert(gaps.length > 0, "the sheet has gaps");
  for (const f of gaps) assert(!f.provenance?.basis, `${f.id} is unlabelled`);
});

// --- Sheet 2: no parent can be found -----------------------------------------------------------

suite("figure basis / an audit-exempt subsidiary with no parent found: own figures, unaudited");

test("Pret A Manger Limited by GLEIF alone: its own figures say they are unaudited under section 479A", async () => {
  const { m, builtFor } = await sheet(PRET, async (n) => (n === PRET ? ownLines() : null), ["gleif"]);
  assertEqual(builtFor.join(","), PRET, "its own filing");
  assertEqual(m.group?.basis, "own", "own figures");
  const turnover = byMetric(m, "turnover");
  assertEqual(turnover.value !== null, true, "its own turnover is held");
  const b = turnover.provenance!.basis!;
  assertEqual(b.kind, "own", "own");
  assertEqual(b.entity.number, PRET, "Pret's own");
  assertEqual(b.audit, "exempt", "exempt");
  assert(b.text.includes("Unaudited: the company claimed the subsidiary audit exemption (Companies Act 2006, section 479A)."), b.text);
  assert(b.text.includes("No parent group accounts could be found"), b.text);
  for (const f of heldFacts(m)) assertEqual(f.provenance!.basis?.entity.number, PRET, `${f.id} is Pret's own`);
});

test("a trading company's own full accounts say nothing about audit either way", () => {
  const m = buildManifest(FIXTURES[0]);
  const out = labelFigures(m, { kind: "own", entity: { number: m.entity.companyNumber, name: m.entity.companyName }, accountsType: "full", filing: null, parentNote: null });
  assertEqual(out.abstained.length, 0, `labelling a whole fixture abstains nothing: ${JSON.stringify(out.abstained)}`);
  for (const f of heldFacts(m)) {
    assertEqual(f.provenance!.basis!.audit, "not-checked", f.id);
    assert(!f.provenance!.basis!.text.includes("audit"), f.provenance!.basis!.text);
  }
  const derived = heldFacts(m).filter((f) => f.rung === "R2");
  assert(derived.length > 0, "the fixture has derived figures");
  for (const f of derived) assertEqual(f.provenance!.basis!.from, "derived", f.id);
});

// --- Sheet 3: the mix that must not happen --------------------------------------------------

suite("figure basis / a sheet that would mix parent and own figures");

test("the subsidiary's own turnover carried onto the parent sheet abstains; the parent's figures stay", async () => {
  // First the subsidiary's own sheet, whose figures are labelled as its own.
  const own = (await sheet(PRET, async (n) => (n === PRET ? ownLines() : null), ["gleif"])).m;
  const carried = structuredClone(byMetric(own, "turnover"));
  assertEqual(carried.provenance!.basis!.entity.number, PRET, "labelled as Pret's own");
  // Then the parent sheet, where the parent's turnover was not read, "topped up" with Pret's.
  const netAssetsOnly = async (n: string) => {
    if (n !== PARENT) return null;
    const read = firstRead("consolidated", { net_assets: found(20, "(42.1)", "Consolidated balance sheet", "Net liabilities") });
    return (await verifyAndMap(read, {}, GROUP_SEEN, "group")).mapped;
  };
  const { m } = await sheet(PRET, netAssetsOnly, undefined, (parentSheet) => {
    parentSheet.facts[carried.id] = carried;
  });
  const t = m.facts[carried.id];
  assertEqual(t.value, null, "the carried figure holds no value");
  assertEqual(t.rung, "R4", "it abstains");
  assertEqual(t.provenance, null, "and carries no provenance, so no label");
  assert(lastLog(t).startsWith(`Abstained: ${MIXED_BASIS_ABSTAIN}`), lastLog(t));
  assert(lastLog(t).includes("PRET PARENT HOLDING LIMITED 13383544") && lastLog(t).includes(PRET), lastLog(t));
  const g = m.group!;
  assert(g.unlabelled?.some((u) => u.id === carried.id), "the sheet lists it as unlabelled");
  const na = byMetric(m, "netAssets");
  assertEqual(na.provenance!.basis!.entity.number, PARENT, "the parent's own figure still lands, labelled");
});

test("the reverse: a parent-group figure on an own-figures sheet abstains", () => {
  const m = buildManifest(FIXTURES[0]);
  const victim = heldFacts(m).find((f) => f.rung === "R1" && f.provenance!.tag === "Acc")!;
  victim.provenance = {
    ...victim.provenance!,
    basis: basisFor(
      {
        kind: "parent-group",
        entity: { number: PARENT, name: "PRET PARENT HOLDING LIMITED" },
        subject: { number: PRET, name: "PRET A MANGER LIMITED" },
        filing: { type: "AA", accountsType: "group", madeUpDate: "2026-01-01", filedOn: "2026-06-30", transactionId: "T" },
      },
      "accounts"
    ),
  };
  const out = labelFigures(m, { kind: "own", entity: { number: m.entity.companyNumber, name: m.entity.companyName }, accountsType: "full", filing: null, parentNote: null });
  assert(out.abstained.some((a) => a.id === victim.id && a.reason.startsWith(MIXED_BASIS_ABSTAIN)), JSON.stringify(out.abstained));
  // Anything computed from it abstains too, and says why.
  for (const f of Object.values(m.facts)) {
    if (f.attemptLog?.some((l) => l.detail.includes(DERIVED_BASIS_ABSTAIN))) assertEqual(f.value, null, `${f.id} abstains with its input`);
  }
});

// --- Figures that cannot be labelled -------------------------------------------------------------

suite("figure basis / a figure that cannot be labelled abstains");

const OWN: SheetOf = { kind: "own", entity: { number: "00000001", name: "TEST LTD" }, accountsType: "full", filing: null, parentNote: null };

function fact(id: string, value: number | null, extra: Partial<Fact> = {}): Fact {
  return {
    id,
    metric: id.split(".")[0],
    label: id,
    period: "FY2026",
    kind: "currency",
    value,
    unit: "GBP",
    rung: value === null ? "R4" : "R1",
    provenance:
      value === null
        ? null
        : { sourceId: "acc", tag: "Acc", documentName: "Accounts", locator: "p.1", snippet: String(value), retrievedAt: "2026-09-22", contentHash: "h" },
    verification: { status: "SINGLE_SOURCE", checks: [] },
    ...extra,
  };
}

function manifestOf(...facts: Fact[]): FactManifest {
  return { entity: {} as never, facts: Object.fromEntries(facts.map((f) => [f.id, f])), sources: {}, generatedAt: "" };
}

test("a held value with no provenance abstains", () => {
  const m = manifestOf(fact("cash.FY2026", 5, { provenance: null }));
  const out = labelFigures(m, OWN);
  assertEqual(m.facts["cash.FY2026"].value, null, "abstains");
  assert(out.abstained[0].reason.startsWith(UNLABELLED_ABSTAIN), out.abstained[0].reason);
});

test("a derived figure is labelled only when every input is held on the sheet's basis", () => {
  const derivedProv = { sourceId: "derived", tag: "Acc" as const, documentName: "Derived line (see inputs)", locator: "f", snippet: "s", retrievedAt: "", contentHash: "h" };
  const ok = manifestOf(
    fact("borrowings.FY2026", 10),
    fact("cash.FY2026", 4),
    fact("netDebt.FY2026", 6, { rung: "R2", provenance: derivedProv, derivation: { formula: "b - c", inputs: ["borrowings.FY2026", "cash.FY2026"] } })
  );
  labelFigures(ok, OWN);
  assertEqual(ok.facts["netDebt.FY2026"].provenance!.basis!.from, "derived", "labelled as derived");

  const gap = manifestOf(
    fact("borrowings.FY2026", 10),
    fact("cash.FY2026", null),
    fact("netDebt.FY2026", 6, { rung: "R2", provenance: derivedProv, derivation: { formula: "b - c", inputs: ["borrowings.FY2026", "cash.FY2026"] } })
  );
  const out = labelFigures(gap, OWN);
  assertEqual(gap.facts["netDebt.FY2026"].value, null, "a derived figure over an abstained input abstains");
  assert(out.abstained[0].reason.includes("cash.FY2026 abstained"), out.abstained[0].reason);
});

test("labelling twice changes nothing", () => {
  const m = buildManifest(FIXTURES[0]);
  labelFigures(m, OWN);
  const once = JSON.stringify(m);
  const out = labelFigures(m, OWN);
  assertEqual(out.abstained.length, 0, "nothing new abstains");
  assertEqual(JSON.stringify(m), once, "same manifest");
});

// --- Composition with WP-BE18's basis check --------------------------------------------------

suite("figure basis / composes with the WP-BE18 basis check");

test("on the parent's group accounts, a company-statement figure abstains on basis and gains no label; the group figure is labelled", async () => {
  const filings = JSON.parse(readFileSync(join(HERE, "fixtures", "group", `filings-${PARENT}.json`), "utf8")) as { items?: ChFilingItem[] };
  assertEqual(selectLatestAccountsFiling(filings.items ?? [])?.accountsType, "group", "the parent's filing is group accounts, so the basis check applies");
  const mixedRead = async (n: string) => {
    if (n !== PARENT) return null;
    const read = firstRead("consolidated", {
      turnover: found(18, "1,120.4", "Consolidated income statement", "Revenue"),
      net_assets: found(20, "298.0", "Company balance sheet", "Net assets"),
    });
    return (
      await verifyAndMap(
        read,
        { net_assets: { basis: "company", basisText: "Company balance sheet" } },
        { basis: "consolidated", basisText: "Consolidated income statement" },
        "group"
      )
    ).mapped;
  };
  const { m } = await sheet(PRET, mixedRead);
  const na = byMetric(m, "netAssets");
  assertEqual(na.value, null, "net assets abstains on basis");
  assertEqual(na.provenance, null, "no provenance");
  assert(!na.provenance?.basis, "and so no parent-group label");
  assert(na.attemptLog!.some((l) => l.detail.includes(BASIS_ABSTAIN)), `the basis reason is kept: ${JSON.stringify(na.attemptLog)}`);
  assert(!JSON.stringify(na).includes("Parent group figure"), "nothing on the abstained figure reads as a surviving parent figure");
  const t = byMetric(m, "turnover");
  assertEqual(t.provenance!.basis!.kind, "parent-group", "the group turnover is labelled");
  assertEqual(m.group!.unlabelled, undefined, "the basis check's abstention is its own, not the label's");
});
