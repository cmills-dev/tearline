// test/resolveName.test.ts
// The UK company resolver (lib/resolve) against recorded Companies House and GLEIF responses.
// Every input in fixtures/resolve/expected.json runs through a fixture-backed client, so no
// test touches the network. A fixture the resolver asks for but was never recorded fails.

import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { suite, test, assert, assertEqual } from "./harness";
import { resolveCompany, FILING_LOOKUPS, PROFILE_LOOKUPS } from "../lib/resolve/resolve";
import { classifyInput } from "../lib/resolve/numbers";
import { normaliseCompanyName, splitLegalForm } from "../lib/resolve/normalise";
import { compareRankKeys, matchName, rankKey } from "../lib/resolve/rank";
import { resolveLei } from "../lib/sources/gleif";
import type { ResolveClient, ResolveResult } from "../lib/resolve/types";

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, "fixtures", "resolve");

interface ExpectedCase {
  slug: string;
  input: string;
  kind: ResolveResult["kind"];
  number: string | null;
  name: string | null;
  lei?: string;
  notResolvedTo?: string[];
  // The pick list's suggestion, where a case pins it (WP-BE14).
  suggested?: string;
  reason: string;
}

function readFixture(slug: string, file: string): unknown {
  const path = join(FIX, slug, file);
  if (!existsSync(path)) throw new Error(`fixture not recorded: ${slug}/${file}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function jsonRes(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response;
}

// A client that serves only what was recorded for one input, and counts register calls.
function fixtureClient(slug: string): ResolveClient & { chCalls: string[] } {
  const chCalls: string[] = [];
  const gleifFetch = (async (url: string) => {
    const m = /registeredAs\]=([^&]+)/.exec(url);
    const path = m ? join(FIX, slug, `gleif-${decodeURIComponent(m[1])}.json`) : "";
    if (!path || !existsSync(path)) return jsonRes(404, null);
    return jsonRes(200, JSON.parse(readFileSync(path, "utf8")));
  }) as unknown as typeof fetch;
  return {
    chCalls,
    async search(q) {
      chCalls.push(`search ${q}`);
      return readFixture(slug, "search.json") as Awaited<ReturnType<ResolveClient["search"]>>;
    },
    async profile(n) {
      chCalls.push(`profile ${n}`);
      return readFixture(slug, `profile-${n}.json`) as Awaited<ReturnType<ResolveClient["profile"]>>;
    },
    async filingHistory(n) {
      chCalls.push(`filings ${n}`);
      return (readFixture(slug, `filings-${n}.json`) as { items: Awaited<ReturnType<ResolveClient["filingHistory"]>> }).items;
    },
    async leiForCompanyNumber(n) {
      const rec = await resolveLei(n, { chNumber: n, fetchImpl: gleifFetch });
      return rec?.lei ?? null;
    },
  };
}

function describe(r: ResolveResult): string {
  if (r.kind === "resolved") return `resolved ${r.company.number} ${r.company.name}`;
  if (r.kind === "pick") return `pick [${r.candidates.map((c) => c.number).join(", ")}]`;
  return `${r.kind}: ${r.reason}`;
}

export async function registerResolveNameTests(): Promise<void> {
  const expected = JSON.parse(readFileSync(join(FIX, "expected.json"), "utf8")) as { cases: ExpectedCase[] };

  suite("resolve / input classification");

  test("an 8-digit number is a number", () => {
    assertEqual(JSON.stringify(classifyInput("00445790")), JSON.stringify({ kind: "number", number: "00445790", register: "England and Wales company" }), "8 digits");
  });
  test("6 and 7 digit numbers are zero-padded to 8", () => {
    const six = classifyInput("445790");
    const seven = classifyInput("2662226");
    assert(six.kind === "number" && six.number === "00445790", "445790 pads to 00445790");
    assert(seven.kind === "number" && seven.number === "02662226", "2662226 pads to 02662226");
  });
  test("case and spaces are tolerated, and each UK prefix is accepted", () => {
    for (const [raw, number] of [
      ["sc 002934", "SC002934"],
      ["ni004842", "NI004842"],
      ["OC343897", "OC343897"],
      ["SO301234", "SO301234"],
      ["nc000123", "NC000123"],
      ["R0000123", "R0000123"],
    ]) {
      const c = classifyInput(raw);
      assert(c.kind === "number" && c.number === number, `${raw} is number ${number}, got ${JSON.stringify(c)}`);
    }
  });
  test("overseas registrations are excluded with a plain reason", () => {
    for (const raw of ["BR014816", "fc031481", "SF000123", "NF000456"]) {
      const c = classifyInput(raw);
      assert(c.kind === "excluded", `${raw} is excluded`);
      if (c.kind === "excluded") assert(/overseas|branch/.test(c.reason), `${raw} reason names the overseas registration: ${c.reason}`);
    }
  });
  test("anything else is a name", () => {
    for (const raw of ["Tesco", "12345", "123456789", "SC12345", "3i Group"]) {
      assertEqual(classifyInput(raw).kind, "name", `${raw} is a name`);
    }
  });

  suite("resolve / name normalisation");

  test("legal forms become canonical tokens", () => {
    assertEqual(normaliseCompanyName("Greggs Public Limited Company"), "GREGGS PLC", "PUBLIC LIMITED COMPANY is PLC");
    assertEqual(normaliseCompanyName("Matalan Retail Ltd."), "MATALAN RETAIL LTD", "LTD. is LTD");
    assertEqual(normaliseCompanyName("Matalan Retail Limited"), "MATALAN RETAIL LTD", "LIMITED is LTD");
    assertEqual(normaliseCompanyName("Irwin Mitchell Limited Liability Partnership"), "IRWIN MITCHELL LLP", "LLP");
  });
  test("ampersand, a leading THE, punctuation, accents and repeated spaces", () => {
    assertEqual(normaliseCompanyName("The  James Fisher & Sons plc"), "JAMES FISHER AND SONS PLC", "& and THE");
    assertEqual(normaliseCompanyName("Caffè Nero Group, Ltd"), "CAFFE NERO GROUP LTD", "accent and comma");
    assertEqual(normaliseCompanyName("WEIR GROUP PLC(THE)"), "WEIR GROUP PLC", "trailing (THE)");
    assertEqual(normaliseCompanyName("Sainsbury's"), "SAINSBURYS", "apostrophe dropped, not split");
  });
  test("letters that do not decompose are folded, not deleted (RS-06)", () => {
    // Real names. Before, Ø, Æ and Đ went through the NFKD strip untouched and were then deleted.
    assertEqual(normaliseCompanyName("Ørsted A/S"), "ORSTED A S", "Ø is O, not deleted (was RSTED A S)");
    assertEqual(normaliseCompanyName("A.P. Møller - Mærsk A/S"), "A P MOLLER MAERSK A S", "Ø is O and Æ is AE (was M RSK)");
    assertEqual(normaliseCompanyName("Bjørn Borg AB"), "BJORN BORG AB", "was BJ RN");
    assertEqual(normaliseCompanyName("Đuro Đaković Grupa d.d."), "DURO DAKOVIC GRUPA D D", "Đ is D; ć decomposes as before");
    // The letters that decompose read as they always did.
    assertEqual(normaliseCompanyName("Nestlé S.A."), "NESTLE S A", "é");
    assertEqual(normaliseCompanyName("Société Générale"), "SOCIETE GENERALE", "é twice");
    assertEqual(normaliseCompanyName("Müller UK & Ireland Group LLP"), "MULLER UK AND IRELAND GROUP LLP", "ü");
  });
  test("the fold agrees with Intl.Collator, and never makes a Cyrillic look-alike Latin", () => {
    const base = new Intl.Collator("en", { sensitivity: "base" });
    const pairs: Array<[string, string]> = [
      ["Ørsted", "Orsted"],
      ["Mærsk", "Maersk"],
      ["Bjørn Borg", "Bjorn Borg"],
      ["Đuro Đaković", "Duro Dakovic"],
      ["Nestlé", "Nestle"],
      ["Société Générale", "Societe Generale"],
      ["Müller", "Muller"],
    ];
    for (const [accented, plain] of pairs) {
      assertEqual(base.compare(accented, plain), 0, `the Collator calls ${accented} and ${plain} the same`);
      assertEqual(normaliseCompanyName(accented), normaliseCompanyName(plain), `and so does the normaliser`);
    }
    // "АСМЕ" here is Cyrillic А, С, М, Е. The Collator keeps scripts apart, and so does the fold.
    assert(base.compare("АСМЕ", "ACME") !== 0, "the Collator does not equate them");
    assertEqual(matchName("Acme Limited", "АСМЕ LIMITED"), null, "a Cyrillic name is not an Acme");
  });
  test("an accented register name matches the name typed without accents, and the reverse", () => {
    assertEqual(matchName("Bjorn Borg AB", "BJØRN BORG AB")?.kind, "exact", "was no match at all");
    assertEqual(matchName("Maersk", "MÆRSK")?.kind, "exact", "was no match at all");
    assertEqual(matchName("Ørsted", "ORSTED A/S")?.kind, "contains", "typed with the accent");
    assertEqual(matchName("Moller Maersk", "A.P. MØLLER - MÆRSK A/S")?.kind, "contains", "every typed word is in the register name");
  });
  test("the core is the name without its legal form", () => {
    assertEqual(JSON.stringify(splitLegalForm("Tesco PLC")), JSON.stringify({ core: "TESCO", form: "PLC" }), "core and form");
    assertEqual(JSON.stringify(splitLegalForm("CCC Group")), JSON.stringify({ core: "CCC GROUP", form: null }), "CCC inside a name is not a form");
  });
  test("a conflicting legal form is not an exact match", () => {
    assertEqual(matchName("Irwin Mitchell LLP", "IRWIN MITCHELL LIMITED")?.kind, "contains", "LLP typed, LIMITED found");
    assertEqual(matchName("Irwin Mitchell LLP", "IRWIN MITCHELL LLP")?.kind, "exact", "same form");
    assertEqual(matchName("PizzaExpress", "PIZZA EXPRESS LIMITED")?.kind, "compact", "spaces ignored");
    assertEqual(matchName("Wilko", "WL REALISATIONS (2023) LIMITED", ["WILKO LIMITED"])?.kind, "previous-name", "previous name");
    assertEqual(matchName("Tesco", "GREGGS PLC"), null, "no match");
  });

  suite("resolve / recorded register inputs");

  test("there are at least 24 recorded inputs", () => {
    assert(expected.cases.length >= 24, `expected.json has ${expected.cases.length} cases`);
  });

  for (const c of expected.cases) {
    test(`${c.input} -> ${c.kind}${c.number ? ` with ${c.number} ${c.name}` : ""}`, async () => {
      const client = fixtureClient(c.slug);
      const r = await resolveCompany(c.input, client);
      assertEqual(r.kind, c.kind, `${c.input}: ${describe(r)}`);
      if (r.kind === "resolved") {
        assertEqual(r.company.number, c.number, `${c.input} resolves to the intended entity`);
        assertEqual(r.company.name, c.name, `${c.input} resolved name`);
      }
      if (r.kind === "pick") {
        const top5 = r.candidates.slice(0, 5).map((x) => x.number);
        assert(c.number !== null && top5.includes(c.number), `${c.input}: ${c.number} in the top five of ${describe(r)}`);
        assert(r.candidates.length <= 8, "at most 8 candidates");
        assertEqual(r.suggested, r.candidates[0].number, "the suggested candidate is the top one");
        if (c.suggested) assertEqual(r.suggested, c.suggested, `${c.input}: the suggestion`);
        for (const x of r.candidates) {
          assert(x.why.length >= 3, `${x.number} says why it ranked where it did`);
          assert(!/^(BR|FC|SF|NF|OE)/.test(x.number), `${x.number} is not an overseas registration`);
        }
      }
      if (r.kind === "none" || r.kind === "excluded") assert(r.reason.length > 20, "a plain reason is given");
      for (const wrong of c.notResolvedTo ?? []) {
        assert(!(r.kind === "resolved" && r.company.number === wrong), `${c.input} never auto-resolves to ${wrong}`);
      }
      if (c.lei) {
        assert(r.kind === "resolved" && r.esef?.lei === c.lei, `${c.input} carries the ESEF hint with LEI ${c.lei}`);
      }
      const searches = client.chCalls.filter((x) => x.startsWith("search")).length;
      assert(searches <= 1, "one search at most");
      assert(client.chCalls.length <= 1 + PROFILE_LOOKUPS + FILING_LOOKUPS, `${c.input} made ${client.chCalls.length} register calls`);
    });
  }

  suite("resolve / specific guarantees");

  test("Wilko, Stonegate and Caffe Nero return a pick list, never a resolution", async () => {
    for (const slug of ["wilko", "stonegate-pub-company", "caffe-nero-group"]) {
      const input = expected.cases.find((x) => x.slug === slug)!.input;
      const r = await resolveCompany(input, fixtureClient(slug));
      assertEqual(r.kind, "pick", `${input} is ambiguous`);
    }
  });
  test("Stonegate's overseas registrations are left out and named in the reason", async () => {
    const r = await resolveCompany("Stonegate Pub Company", fixtureClient("stonegate-pub-company"));
    assert(r.kind === "pick" && r.reason.includes("BR014816"), `reason names BR014816: ${r.kind === "pick" ? r.reason : r.kind}`);
  });
  test("a previous-name match says which previous name matched", async () => {
    const r = await resolveCompany("Wilko", fixtureClient("wilko"));
    const wl = r.kind === "pick" ? r.candidates.find((x) => x.number === "00365335") : undefined;
    assert(wl !== undefined, "WL REALISATIONS is listed");
    assertEqual(wl!.match, "previous-name", "matched on a previous name");
    assert(wl!.why.some((w) => w.includes("previously named WILKO")), `why names the previous name: ${wl!.why.join("; ")}`);
  });
  test("Wilko suggests the retailer, not the shell that took its name (WP-BE14, QA04)", async () => {
    const r = await resolveCompany("Wilko", fixtureClient("wilko"));
    assert(r.kind === "pick", "still a pick list, never a resolution");
    if (r.kind !== "pick") return;
    assertEqual(r.suggested, "00365335", "WL REALISATIONS (2023) LIMITED, formerly WILKO LIMITED, full accounts");
    const shell = r.candidates.findIndex((x) => x.number === "09563205");
    assert(shell > 0, `the micro-entity shell 09563205 is listed after the retailer (at ${shell})`);
  });
  test("the shell rule: figures beat a shell on the register, but a dissolved company stays last", () => {
    const base = {
      name: "X",
      type: "ltd",
      incorporatedOn: null,
      locality: null,
      previousNames: [],
      hasAccountsFiling: true,
      why: [],
      match: "exact" as const,
    };
    const shell = { ...base, number: "1", status: "active", lastAccounts: { madeUpTo: "2025-01-31", type: "micro-entity" as const } };
    const insolventReal = { ...base, number: "2", status: "liquidation", lastAccounts: { madeUpTo: "2022-01-29", type: "full" as const } };
    const dissolvedReal = { ...base, number: "3", status: "dissolved", lastAccounts: { madeUpTo: "2020-01-29", type: "full" as const } };
    const activeReal = { ...base, number: "4", status: "active", lastAccounts: { madeUpTo: "2025-01-31", type: "full" as const } };
    const lp = { ...base, number: "5", status: "active", type: "limited-partnership", lastAccounts: null };
    const order = [shell, insolventReal, dissolvedReal, activeReal, lp]
      .map((c, i) => ({ c, k: rankKey(c as never, i) }))
      .sort((a, b) => compareRankKeys(a.k, b.k))
      .map((x) => x.c.number)
      .join(",");
    assertEqual(order, "4,2,1,5,3", "active with figures, insolvent with figures, active shell, no-accounts type, dissolved");
  });
  // Shaped on the register's public pages as read on 27 Sep 2026 (no API recording exists for
  // these two). Only the fields the resolver reads; an accounts type the page does not show is
  // left out rather than guessed.
  function inlineClient(items: Array<{ number: string; title: string; snippet?: string; madeUpTo: string; type?: string }>): ResolveClient {
    return {
      search: async () => ({
        items: items.map((i) => ({ company_number: i.number, title: i.title, company_status: "dissolved", company_type: "ltd", ...(i.snippet ? { snippet: i.snippet } : {}) })),
      }),
      profile: async (n) => {
        const i = items.find((x) => x.number === n)!;
        return {
          company_number: i.number,
          company_name: i.title,
          company_status: "dissolved",
          type: "ltd",
          accounts: { last_accounts: { made_up_to: i.madeUpTo, ...(i.type ? { type: i.type } : {}) } },
        } as never;
      },
      filingHistory: async () => [],
      leiForCompanyNumber: async () => null,
    };
  }
  test("Homebase: when every match is dissolved, the pick list says the trading business files under another name (WP-BE14)", async () => {
    const r = await resolveCompany(
      "Homebase Holdings",
      inlineClient([
        { number: "03000032", title: "HOMEBASE HOLDINGS LIMITED", madeUpTo: "2018-06-30", type: "dormant" },
        { number: "09944258", title: "HOMEBASE (UK&I) HOLDINGS LIMITED", madeUpTo: "2020-12-27" },
      ]),
    );
    assert(r.kind === "pick", `a pick list, never a resolution: ${describe(r)}`);
    if (r.kind !== "pick") return;
    assertEqual(r.suggested, "03000032", "the exact name still leads; nothing is guessed");
    assert(/All 2 companies that match are dissolved/.test(r.reason), r.reason);
    assert(/files under another company name/.test(r.reason), r.reason);
  });
  test("New Look: a single dissolved former-name match is a pick list that says so (WP-BE14)", async () => {
    const r = await resolveCompany(
      "New Look Retail Group",
      inlineClient([{ number: "05810406", title: "TOP GUN REALISATIONS 90 LIMITED", snippet: "NEW LOOK RETAIL GROUP LIMITED", madeUpTo: "2019-03-30", type: "group" }]),
    );
    assert(r.kind === "pick", `a pick list: ${describe(r)}`);
    if (r.kind !== "pick") return;
    assert(/The only company that matches is dissolved/.test(r.reason), r.reason);
  });
  test("a live match is not given the dissolved note", async () => {
    const r = await resolveCompany("Wilko", fixtureClient("wilko"));
    assert(r.kind === "pick" && !/dissolved, so the last accounts are old/.test(r.reason), r.kind === "pick" ? r.reason : r.kind);
  });
  test("pick-list candidates carry the fields the pick list shows", async () => {
    const r = await resolveCompany("Pret A Manger", fixtureClient("pret-a-manger"));
    assert(r.kind === "pick", "Pret is a pick list");
    if (r.kind !== "pick") return;
    const top = r.candidates[0];
    assert(!!top.number && !!top.name && !!top.status && !!top.type, "number, name, status, type");
    assert(top.incorporatedOn !== null && top.locality !== null, "incorporation date and locality");
    assert(top.lastAccounts !== null && !!top.lastAccounts.madeUpTo && top.lastAccounts.type !== "unknown", "last accounts date and type");
  });
  test("a dissolved company by number resolves and says it is dissolved", async () => {
    const r = await resolveCompany("00278576", fixtureClient("number-00278576"));
    assert(r.kind === "resolved" && /dissolved/.test(r.reason), `reason says dissolved: ${describe(r)}`);
  });
  test("a number with no profile is none", async () => {
    const client: ResolveClient = {
      search: async () => ({ items: [] }),
      profile: async () => null,
      filingHistory: async () => [],
      leiForCompanyNumber: async () => null,
    };
    const r = await resolveCompany("99999999", client);
    assertEqual(r.kind, "none", "no such company");
  });
  test("an overseas number makes no register call", async () => {
    const client = fixtureClient("number-br014816");
    const r = await resolveCompany("BR014816", client);
    assertEqual(r.kind, "excluded", "excluded");
    assertEqual(client.chCalls.length, 0, "no calls");
  });
}
