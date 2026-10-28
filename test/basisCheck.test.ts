// test/basisCheck.test.ts
// The basis check (WP-BE18). When the resolver says a filing is group accounts, a scanned figure
// lands only when both reads put it in the group's statements and a printed heading says so. The
// second read is scripted here: no test calls the API or a model. The pages cut for the second
// read are real pages of a frozen gold scan (Bristol Water), because the verifier cuts them before
// it calls the model; what the scripted model "sees" on them is what each test says it sees.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { suite, test, assert, assertEqual } from "./harness";
import { InMemoryCache } from "../lib/cache/cache";
import { AnthropicProvider, acceptsEffort } from "../lib/llm/providers/anthropic";
import type { LLMRequest, StructuredLLMProvider } from "../lib/llm/types";
import { parseSecondRead, SECOND_READ_SCHEMA, secondReadUserText, type SecondReadWire, type SecondWireLine } from "../lib/vision/secondRead";
import {
  BASIS_ABSTAIN,
  DoubleReadVerifier,
  SECOND_READ_EFFORT,
  applyVerification,
  headingBasis,
  judgeDoubleRead,
} from "../lib/vision/verify";
import { visionLines } from "../lib/sources/visionAccounts";
import { selectLatestAccountsFiling } from "../lib/resolve/filings";
import type { ChFilingItem } from "../lib/resolve/types";
import { BASE_LINE_KEYS, type BaseLineKey, type FoundLine, type VisionLine, type VisionReadResult } from "../lib/vision/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const PDF = join(HERE, "..", "eval", "gold", "fixtures", "uk", "02662226-2026-03-31", "filing.pdf");
const PERIOD = "2026-03-31";

// --- A first read -----------------------------------------------------------

export function found(page: number, figureText: string, statement: string, printedLabel: string): FoundLine {
  const negative = figureText.startsWith("(");
  const magnitude = Number(figureText.replace(/[(),]/g, ""));
  return {
    status: "found",
    printedLabel,
    figureText,
    value: negative ? -magnitude : magnitude,
    sign: negative ? "negative" : "positive",
    scaleCaption: "£m",
    pdfPageIndex: page,
    printedPageNumber: null,
    statement,
    periodEnd: PERIOD,
    noteReference: null,
  };
}

export function firstRead(basis: VisionReadResult["document"]["basis"], found: Partial<Record<BaseLineKey, FoundLine>>): VisionReadResult {
  const lines = Object.fromEntries(
    BASE_LINE_KEYS.map((k) => [k, found[k] ?? { status: "abstain", reason: "not-printed" }])
  ) as Record<BaseLineKey, VisionLine>;
  return {
    outcome: "read",
    fromCache: false,
    cacheKey: "test",
    schemaVersion: 1,
    promptVersion: "p2",
    model: "claude-opus-5",
    transactionId: "basis-test",
    companyNumber: "02662226",
    pageSet: "all",
    document: { companyNameAsPrinted: "Test Group plc", periodEnd: PERIOD, currency: "GBP", basis },
    lines,
    debtNote: { status: "abstain", reason: "not-read" },
    usage: null,
    recordedUsage: null,
  };
}

// --- A scripted second read ---------------------------------------------------

interface Seen {
  basis: SecondWireLine["basis"];
  basisText: string;
  statement?: string; // what the second read gives as the heading; defaults to the first read's
  column?: string;
}

function secondLine(key: BaseLineKey, first: FoundLine, excerptPage: number, seen: Seen): SecondWireLine {
  return {
    key,
    status: "found",
    abstain_reason: "",
    printed_label: first.printedLabel ?? "",
    figure_text: first.figureText,
    sign: first.sign,
    scale_caption: "£m",
    header_scale_caption: "£m",
    header_currency: "£",
    column_heading: seen.column ?? "2026",
    period_end: PERIOD,
    excerpt_page: excerptPage,
    statement: seen.statement ?? first.statement,
    basis: seen.basis,
    basis_text: seen.basisText,
  };
}

function wireFor(read: VisionReadResult, seen: Partial<Record<BaseLineKey, Seen>>, fallback: Seen): { wire: SecondReadWire; pages: number[] } {
  const foundKeys = BASE_LINE_KEYS.filter((k) => read.lines[k].status === "found");
  const pages = [...new Set(foundKeys.map((k) => (read.lines[k] as FoundLine).pdfPageIndex))].sort((a, b) => a - b);
  const lines = foundKeys.map((k) => {
    const f = read.lines[k] as FoundLine;
    return secondLine(k, f, pages.indexOf(f.pdfPageIndex) + 1, seen[k] ?? fallback);
  });
  const tie_lines = (["total_equity", "total_liabilities", "current_assets", "borrowings_total", "net_debt"] as const).map((role) => ({
    role,
    status: "abstain" as const,
    abstain_reason: "not-printed",
    printed_label: "",
    figure_text: "",
    sign: "none" as const,
    scale_caption: "",
    column_heading: "",
    period_end: "",
    excerpt_page: 0,
  }));
  return { wire: { lines, tie_lines }, pages };
}

// A provider that answers every call with the given second read and keeps the requests.
function scripted(answer: SecondReadWire, requests: LLMRequest[] = []): StructuredLLMProvider {
  return {
    name: "scripted",
    model: "claude-opus-5",
    complete: async () => JSON.stringify(answer),
    send: async (req: LLMRequest) => {
      requests.push(req);
      return {
        ok: true,
        text: JSON.stringify(answer),
        stopReason: "end_turn",
        usage: {
          provider: "anthropic",
          model: "claude-opus-5",
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          durationMs: 1,
          attempts: 1,
          costUsd: 0,
          costGbp: 0,
          priced: true,
          stopReason: "end_turn",
        },
      };
    },
  };
}

export async function verifyAndMap(
  read: VisionReadResult,
  seen: Partial<Record<BaseLineKey, Seen>>,
  fallback: Seen,
  accountsType: string | null,
  requests: LLMRequest[] = []
) {
  const { wire } = wireFor(read, seen, fallback);
  const bytes = new Uint8Array(readFileSync(PDF));
  const verification = await new DoubleReadVerifier({ provider: scripted(wire, requests), cache: new InMemoryCache() }).verify({
    read,
    pdfBytes: bytes,
    pageCount: 28,
    accountsType: accountsType as never,
  });
  const applied = applyVerification(read, verification);
  const mapped = visionLines(applied.read, applied.tags, PERIOD, { accountsType: accountsType as never });
  return { verification, mapped };
}

const landed = (m: { figures: { key: BaseLineKey }[] }) => m.figures.map((f) => f.key).sort().join(",");
const reasonFor = (m: { abstentions: { key: BaseLineKey; reason: string }[] }, k: BaseLineKey) => m.abstentions.find((a) => a.key === k)?.reason ?? "";

export const GROUP_SEEN: Seen = { basis: "consolidated", basisText: "Consolidated statement of financial position" };

// --- Headings ---------------------------------------------------------------

suite("basis check / what a printed heading says");

test("group, consolidated, company, mixed and silent headings", () => {
  assertEqual(headingBasis("Consolidated statement of financial position"), "group", "consolidated");
  assertEqual(headingBasis("Group balance sheet"), "group", "group");
  assertEqual(headingBasis("GROUP INCOME STATEMENT"), "group", "any case");
  assertEqual(headingBasis("Notes to the consolidated financial statements"), "group", "a notes page title");
  assertEqual(headingBasis("Group 2026"), "group", "a group column");
  assertEqual(headingBasis("Company balance sheet"), "company", "company");
  assertEqual(headingBasis("Parent company statement of financial position"), "company", "parent company");
  assertEqual(headingBasis("Company 2026"), "company", "a company column");
  assertEqual(headingBasis("Consolidated and company balance sheets"), "mixed", "both at once establishes neither");
  assertEqual(headingBasis("Balance sheet"), "none", "silent");
  assertEqual(headingBasis("18. Borrowings"), "none", "a note title");
  assertEqual(headingBasis(""), "none", "nothing printed");
});

// --- Group filings ----------------------------------------------------------

suite("basis check / group accounts");

test("a figure under a consolidated heading, agreed by both reads, lands with the heading on its citation", async () => {
  const read = firstRead("consolidated", {
    net_assets: found(20, "412.5", "Consolidated statement of financial position", "Net assets"),
    turnover: found(18, "180.2", "Group income statement", "Revenue"),
  });
  const { mapped } = await verifyAndMap(read, { turnover: { basis: "consolidated", basisText: "Group income statement" } }, GROUP_SEEN, "group");
  assertEqual(landed(mapped), "net_assets,turnover", "both land");
  const na = mapped.figures.find((f) => f.key === "net_assets")!;
  assertEqual(na.tag.evidence?.basis?.heading, "Consolidated statement of financial position", "the group heading is on the record");
  assert(na.citation.includes("group accounts"), `the citation says so: ${na.citation}`);
});

test("the company-only balance sheet inside a group filing abstains, even when both reads agree on the figure", async () => {
  const read = firstRead("consolidated", {
    net_assets: found(20, "298.0", "Company balance sheet", "Net assets"),
  });
  const { mapped } = await verifyAndMap(read, {}, { basis: "company", basisText: "Company balance sheet" }, "group");
  assertEqual(landed(mapped), "", "nothing lands");
  assert(reasonFor(mapped, "net_assets").startsWith(BASIS_ABSTAIN), `reason: ${reasonFor(mapped, "net_assets")}`);
});

test("a figure read from the Company column of a combined balance sheet abstains", async () => {
  const read = firstRead("consolidated", {
    net_assets: found(20, "298.0", "Consolidated and company balance sheets", "Net assets"),
  });
  const { mapped } = await verifyAndMap(read, {}, { basis: "consolidated", basisText: "Consolidated and company balance sheets", column: "Company 2026" }, "group");
  assertEqual(landed(mapped), "", "nothing lands");
  assert(reasonFor(mapped, "net_assets").includes(`"Company 2026"`), `names the column: ${reasonFor(mapped, "net_assets")}`);
});

test("the second read cannot tell the basis: the reads disagree, and the figure abstains", async () => {
  const read = firstRead("consolidated", {
    net_assets: found(20, "412.5", "Consolidated statement of financial position", "Net assets"),
  });
  const { mapped } = await verifyAndMap(read, {}, { basis: "none", basisText: "" }, "group");
  assertEqual(landed(mapped), "", "nothing lands");
  assert(reasonFor(mapped, "net_assets").startsWith("The two reads did not agree on the basis"), `reason: ${reasonFor(mapped, "net_assets")}`);
});

test("the first read took the company statements while the second says consolidated: abstains", async () => {
  const read = firstRead("company", {
    net_assets: found(20, "412.5", "Balance sheet", "Net assets"),
  });
  const { mapped } = await verifyAndMap(read, {}, { basis: "consolidated", basisText: "Group balance sheet" }, "group");
  assertEqual(landed(mapped), "", "nothing lands");
  assert(reasonFor(mapped, "net_assets").startsWith(BASIS_ABSTAIN), `reason: ${reasonFor(mapped, "net_assets")}`);
});

test("both reads say consolidated but nothing printed says group: abstains, because the check is the words on the page", async () => {
  const read = firstRead("consolidated", {
    net_assets: found(20, "412.5", "Balance sheet", "Net assets"),
  });
  const { mapped } = await verifyAndMap(read, {}, { basis: "consolidated", basisText: "" }, "group");
  assertEqual(landed(mapped), "", "nothing lands");
  assert(reasonFor(mapped, "net_assets").startsWith(BASIS_ABSTAIN), `reason: ${reasonFor(mapped, "net_assets")}`);
});

test("a note to the group accounts, titled only '18. Borrowings', lands on its printed page title", async () => {
  const read = firstRead("consolidated", {
    borrowings_after_one_year: found(24, "120.0", "18. Borrowings", "Bank loans"),
  });
  const withTitle = await verifyAndMap(read, {}, { basis: "consolidated", basisText: "Notes to the consolidated financial statements" }, "group");
  assertEqual(landed(withTitle.mapped), "borrowings_after_one_year", "the page title establishes the group basis");
  const noTitle = await verifyAndMap(read, {}, { basis: "consolidated", basisText: "" }, "group");
  assertEqual(landed(noTitle.mapped), "", "without it the figure abstains");
});

test("the basis check runs line by line: one company line abstains, the group lines still land", async () => {
  const read = firstRead("consolidated", {
    net_assets: found(20, "412.5", "Group balance sheet", "Net assets"),
    cash_at_bank: found(21, "35.0", "Company balance sheet", "Cash at bank"),
  });
  const { mapped } = await verifyAndMap(read, { cash_at_bank: { basis: "company", basisText: "Company balance sheet" } }, { basis: "consolidated", basisText: "Group balance sheet" }, "group");
  assertEqual(landed(mapped), "net_assets", "only the group line");
  assert(reasonFor(mapped, "cash_at_bank").startsWith(BASIS_ABSTAIN), "the company line says why");
});

test("a verified tag without the basis on record cannot land a figure from a group filing", () => {
  const read = firstRead("consolidated", {
    net_assets: found(20, "412.5", "Group balance sheet", "Net assets"),
  });
  const { wire, pages } = wireFor(read, {}, { basis: "consolidated", basisText: "Group balance sheet" });
  // Judged with the check, then the basis evidence struck off, as a verifier that skipped the
  // check would leave it. (Before WP-GRPCHK this judged the read as if it were not group accounts;
  // a read that prints "Group balance sheet" is now held to the check whatever the register says.)
  const judged = judgeDoubleRead(read, wire, pages, undefined, { accountsType: "group" });
  assertEqual(judged.lines.net_assets.tag, "verified", "the double read agreed");
  const tags = { ...judged.lines, net_assets: { ...judged.lines.net_assets, evidence: { ...judged.lines.net_assets.evidence!, basis: undefined } } };
  assertEqual(tags.net_assets.evidence?.basis, undefined, "no basis on record");
  const onGroup = visionLines(read, tags, PERIOD, { accountsType: "group" });
  assertEqual(landed(onGroup), "", "the landing rule stops it");
  assert(reasonFor(onGroup, "net_assets").startsWith(BASIS_ABSTAIN), `reason: ${reasonFor(onGroup, "net_assets")}`);
  // WP-GRPCHK: the register's label no longer decides it. The first read took the consolidated
  // statements, so on a filing lodged as "full" the landing rule stops it too, and says why.
  const onFull = visionLines(read, tags, PERIOD, { accountsType: "full" });
  assertEqual(landed(onFull), "", "a group's read lodged as full accounts is stopped as well");
  assert(reasonFor(onFull, "net_assets").includes('the register calls it "full" accounts'), `reason: ${reasonFor(onFull, "net_assets")}`);
});

// --- Company-only filings -----------------------------------------------------

suite("basis check / a company-only filing is unaffected");

test("full accounts with a company balance sheet land exactly as before, with no basis on record", async () => {
  const read = firstRead("company", {
    net_assets: found(20, "412.5", "Balance sheet", "Net assets"),
    cash_at_bank: found(20, "35.0", "Company balance sheet", "Cash at bank"),
  });
  for (const accountsType of ["full", "small", "audit-exempt subsidiary", null]) {
    const { mapped } = await verifyAndMap(read, {}, { basis: "none", basisText: "" }, accountsType);
    assertEqual(landed(mapped), "cash_at_bank,net_assets", `${accountsType}: both land`);
    assertEqual(mapped.figures[0].tag.evidence?.basis, undefined, `${accountsType}: the check did not run`);
  }
});

test("a second read recorded before WP-BE18, with no basis fields, still parses and says 'none'", () => {
  const read = firstRead("consolidated", { net_assets: found(20, "412.5", "Group balance sheet", "Net assets") });
  const { wire } = wireFor(read, {}, GROUP_SEEN);
  const v1 = JSON.parse(JSON.stringify(wire));
  for (const l of v1.lines) {
    delete l.basis;
    delete l.basis_text;
  }
  const parsed = parseSecondRead(JSON.stringify(v1));
  assert(parsed.ok, "parses");
  if (parsed.ok) {
    assertEqual(parsed.value.lines[0].basis, "none", "no basis claimed");
    assertEqual(parsed.value.lines[0].basis_text, "", "no words");
  }
  const half = JSON.parse(JSON.stringify(wire));
  delete half.lines[0].basis_text;
  assert(!parseSecondRead(JSON.stringify(half)).ok, "a v2 line missing one field is still malformed");
});

// --- WP-BE12: a subsidiary built from its parent's group accounts ---------------

suite("basis check / composes with WP-BE12 parent group figures");

test("the parent's group accounts pass: Pret's parent files group accounts, and its group balance sheet lands", async () => {
  const filings = JSON.parse(readFileSync(join(HERE, "fixtures", "group", "filings-13383544.json"), "utf8")) as { items?: ChFilingItem[] };
  const parentFiling = selectLatestAccountsFiling(filings.items ?? []);
  assertEqual(parentFiling?.accountsType, "group", "the filing the parent build reads is group accounts, so the check applies");
  const read = firstRead("consolidated", {
    net_assets: found(20, "(42.1)", "Consolidated balance sheet", "Net liabilities"),
    turnover: found(18, "1,120.4", "Consolidated income statement", "Revenue"),
  });
  const { mapped } = await verifyAndMap(read, {}, { basis: "consolidated", basisText: "Consolidated balance sheet" }, parentFiling!.accountsType);
  assertEqual(landed(mapped), "net_assets,turnover", "the parent group's figures land, to be labelled by WP-BE12");
});

// --- What the second read is sent ---------------------------------------------

suite("basis check / the second read finds the basis for itself");

test("the request asks for the basis per line, tells the model nothing of the first read's basis, and caps effort", async () => {
  const read = firstRead("consolidated", { net_assets: found(20, "412.5", "Group balance sheet", "Net assets") });
  const requests: LLMRequest[] = [];
  await verifyAndMap(read, {}, GROUP_SEEN, "group", requests);
  assertEqual(requests.length, 1, "one call");
  const req = requests[0];
  assertEqual(req.outputSchema, SECOND_READ_SCHEMA, "the v2 schema");
  const lineProps = ((SECOND_READ_SCHEMA as any).properties.lines.items.properties) as Record<string, unknown>;
  assert("basis" in lineProps && "basis_text" in lineProps, "basis fields on every line");
  const userText = (req.content as any[]).find((b) => b.type === "text").text as string;
  assertEqual(userText, secondReadUserText("02662226", ["net_assets"], 1), "only the keys and the page count");
  assert(!/consolidated|group|company'?s own/i.test(userText), "no basis in the user text");
  assertEqual(req.effort, SECOND_READ_EFFORT, "effort capped");
});

test("the provider puts effort in output_config beside the schema, and leaves it off models that reject it", async () => {
  const bodies: any[] = [];
  const make = (model: string) =>
    new AnthropicProvider(
      { provider: "anthropic", model, apiKey: "replay", maxTokens: 1024 },
      {
        fetchImpl: async (_u: unknown, init?: RequestInit) => {
          bodies.push(JSON.parse(String(init?.body)));
          return new Response(
            JSON.stringify({ content: [{ type: "text", text: "{}" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        },
        logUsage: () => {},
      }
    );
  await make("claude-opus-5").send({ content: "x", outputSchema: { type: "object" }, effort: "medium" });
  await make("claude-haiku-4-5").send({ content: "x", outputSchema: { type: "object" }, effort: "medium" });
  await make("claude-opus-5").send({ content: "x" });
  assertEqual(bodies[0].output_config.effort, "medium", "Opus 5 gets the effort");
  assertEqual(bodies[0].output_config.format.type, "json_schema", "beside the schema");
  assertEqual(bodies[1].output_config.effort, undefined, "Haiku 4.5 does not");
  assertEqual(bodies[1].output_config.format.type, "json_schema", "but keeps the schema");
  assertEqual(bodies[2].output_config, undefined, "no output_config when neither is asked for");
  assert(acceptsEffort("claude-opus-5") && !acceptsEffort("claude-haiku-4-5-20251001"), "acceptsEffort");
});
