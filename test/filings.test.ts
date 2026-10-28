// test/filings.test.ts
// Filing selection and accounts-type labels (lib/resolve filings.ts and accountsType.ts), on
// real accounts-category filing histories recorded from Companies House plus small synthetic
// lists for the edge cases the register did not happen to show.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { suite, test, assert, assertEqual } from "./harness";
import { documentFormats, selectLatestAccountsFiling } from "../lib/resolve/filings";
import { accountsTypeLabel, labelForAccountsTypeKey } from "../lib/resolve/accountsType";
import type { ChFilingItem, ChProfile } from "../lib/resolve/types";

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, "fixtures", "resolve");

function filings(slug: string, number: string): ChFilingItem[] {
  return (JSON.parse(readFileSync(join(FIX, slug, `filings-${number}.json`), "utf8")) as { items: ChFilingItem[] }).items;
}
function profile(slug: string, number: string): ChProfile {
  return JSON.parse(readFileSync(join(FIX, slug, `profile-${number}.json`), "utf8")) as ChProfile;
}
function item(type: string, date: string, madeUp: string | null, opts: { doc?: boolean; description?: string } = {}): ChFilingItem {
  return {
    transaction_id: `${type}-${date}`,
    category: "accounts",
    type,
    date,
    description: opts.description ?? "accounts-with-accounts-type-full",
    ...(madeUp ? { description_values: { made_up_date: madeUp } } : {}),
    links: opts.doc === false ? { self: "/x" } : { self: "/x", document_metadata: `https://document-api/${type}-${date}` },
  };
}

export async function registerFilingsTests(): Promise<void> {
  suite("resolve / filing selection");

  test("an AA01 as the newest accounts filing is skipped (Wilko, WL Realisations 00365335)", () => {
    const items = filings("wilko", "00365335");
    assertEqual(items[0].type, "AA01", "the recorded newest filing is an AA01");
    const s = selectLatestAccountsFiling(items);
    assert(s !== null, "an accounts filing is selected");
    assertEqual(s!.type, "AA", "AA taken");
    assertEqual(s!.madeUpDate, "2022-01-29", "the latest real accounts");
    assert(s!.transactionId !== items[0].transaction_id, "not the AA01");
  });

  test("an AAMD as the newest accounts filing is taken (Travelodge Hotels 00769170)", () => {
    const items = filings("travelodge-hotels", "00769170");
    assertEqual(items[0].type, "AAMD", "the recorded newest filing is an AAMD");
    const s = selectLatestAccountsFiling(items);
    assertEqual(s?.type, "AAMD", "AAMD taken");
    assertEqual(s?.transactionId, items[0].transaction_id, "the amended filing itself");
    assertEqual(s?.madeUpDate, "2024-12-31", "made up to 31 Dec 2024");
    assertEqual(s?.accountsType, "full", "amended full accounts are labelled full");
  });

  test("an AAMD for the same period beats the original AA even if listed after it", () => {
    const s = selectLatestAccountsFiling([
      item("AA", "2025-04-14", "2024-12-31"),
      item("AAMD", "2025-05-07", "2024-12-31", { description: "accounts-amended-with-accounts-type-full" }),
    ]);
    assertEqual(s?.type, "AAMD", "later filing for the same period wins");
  });

  test("an AAMD for an older period does not beat newer accounts", () => {
    const s = selectLatestAccountsFiling([
      item("AAMD", "2026-01-10", "2023-12-31"),
      item("AA", "2025-09-01", "2024-12-31"),
    ]);
    assertEqual(s?.type, "AA", "latest made-up date wins");
    assertEqual(s?.madeUpDate, "2024-12-31", "2024 accounts");
  });

  test("a made-up date later than the filing date is not trusted", () => {
    const real = filings("wilko", "00365335");
    assert(
      real.some((x) => (x.description_values?.made_up_date ?? "") > x.date),
      "the recorded WL Realisations history holds a made-up date after its filing date"
    );
    const s = selectLatestAccountsFiling([
      item("AA", "1974-03-01", "2073-01-27"),
      item("AA", "2022-11-28", "2022-01-29"),
    ]);
    assertEqual(s?.madeUpDate, "2022-01-29", "the 2073 keying error does not win");
  });

  test("no accounts filed gives null", () => {
    assertEqual(selectLatestAccountsFiling(filings("comet-group-limited", "11975467")), null, "empty recorded history");
    assertEqual(selectLatestAccountsFiling(filings("travelodge-hotels", "17185325")), null, "a history holding only an AA01");
  });

  test("an item with no document link is skipped", () => {
    const real = filings("greggs", "00502851");
    const stripped = real.map((x, i) => (i === 0 ? { ...x, links: { self: x.links?.self } } : x));
    const s = selectLatestAccountsFiling(stripped);
    assert(s !== null, "an older filing is selected");
    assert(s!.transactionId !== real[0].transaction_id, "the newest filing without a document is not selected");
    assertEqual(
      selectLatestAccountsFiling([item("AA", "2026-01-01", "2025-06-30", { doc: false })]),
      null,
      "an only filing with no document gives null"
    );
  });

  test("Greggs and Tesco select their latest group accounts", () => {
    const g = selectLatestAccountsFiling(filings("greggs", "00502851"));
    const t = selectLatestAccountsFiling(filings("tesco", "00445790"));
    assertEqual(g?.madeUpDate, "2025-12-27", "Greggs made up to 27 Dec 2025");
    assertEqual(g?.accountsType, "group", "Greggs group");
    assertEqual(t?.madeUpDate, "2026-02-28", "Tesco made up to 28 Feb 2026");
    assertEqual(t?.accountsType, "group", "Tesco group");
    assertEqual(g?.formats, null, "formats unknown until document metadata is read");
  });

  test("document formats come from the metadata resources", () => {
    const f = documentFormats({ resources: { "application/pdf": {}, "application/xhtml+xml": {} } });
    assert(f.ixbrl && f.pdf, "both");
    const p = documentFormats({ resources: { "application/pdf": {} } });
    assert(!p.ixbrl && p.pdf, "PDF only");
  });

  suite("resolve / accounts-type labels");

  test("every Companies House accounts type has its own label", () => {
    const cases: Array<[string, string]> = [
      ["full", "full"],
      ["group", "group"],
      ["small", "small"],
      ["medium", "medium"],
      ["micro-entity", "micro-entity"],
      ["dormant", "dormant"],
      ["audit-exemption-subsidiary", "audit-exempt subsidiary"],
      ["filing-exemption-subsidiary", "filing-exempt subsidiary"],
      ["filleted", "filleted"],
      ["abridged", "abridged"],
      ["audited-abridged", "abridged"],
      ["total-exemption-full", "total exemption full"],
      ["total-exemption-small", "total exemption small"],
      ["unaudited-abridged", "unaudited abridged"],
      ["initial", "initial"],
      ["interim", "interim"],
      ["partial-exemption", "partial exemption"],
    ];
    for (const [key, label] of cases) assertEqual(labelForAccountsTypeKey(key), label, key);
  });

  test("anything else, or null, is unknown and never filleted", () => {
    for (const key of [null, undefined, "", "no-accounts-type-available", "legacy", "accounts-with-made-up-date", "banana", "toString"]) {
      assertEqual(labelForAccountsTypeKey(key), "unknown", String(key));
    }
  });

  test("filing descriptions map, including the register's own spellings", () => {
    assertEqual(labelForAccountsTypeKey("accounts-with-accounts-type-group"), "group", "group");
    assertEqual(labelForAccountsTypeKey("accounts-with-accounts-type-full-group"), "group", "full-group");
    assertEqual(labelForAccountsTypeKey("accounts-amended-with-accounts-type-full-group"), "group", "amended full-group");
    assertEqual(labelForAccountsTypeKey("accounts-with-accounts-type-audit-exemption-subsiduary"), "audit-exempt subsidiary", "CH spelling");
  });

  test("Greggs and Tesco profiles are labelled group", () => {
    assertEqual(accountsTypeLabel(profile("greggs", "00502851")), "group", "Greggs");
    assertEqual(accountsTypeLabel(profile("tesco", "00445790")), "group", "Tesco");
    assertEqual(accountsTypeLabel(profile("wagamama", "02605751")), "audit-exempt subsidiary", "Wagamama");
    assertEqual(accountsTypeLabel(profile("wilko", "09563205")), "micro-entity", "Wilko Limited shell");
    assertEqual(accountsTypeLabel(null), "unknown", "no profile");
  });
}
