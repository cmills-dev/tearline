// test/companiesHouseLive.test.ts
// Exercises the REAL Companies House live-data path with a mocked global fetch. The
// harness is synchronous, so the async fetch work runs inside registerLiveTests(),
// which test/run.ts awaits BEFORE running the suite. Every assertion below reads a
// value captured during that async setup.

import {
  assembleLiveTearSheet,
  buildLiveFactManifest,
  mapLiveToManifest,
  searchCompanies,
} from "../lib/sources/companiesHouseLive";
import type {
  ChargesList,
  CompanyProfile,
  CompanySearchResult,
} from "../lib/sources/companiesHouse";
import type { FactManifest } from "../lib/engine/types";
import type { TearSheet } from "../lib/engine/assemble";
import { suite, test, assert, assertEqual } from "./harness";

// --- Sample real-shaped API payloads -----------------------------------------

const PROFILE: CompanyProfile = {
  company_name: "ACME WIDGETS LIMITED",
  company_number: "12345678",
  company_status: "active",
  date_of_creation: "2001-06-15",
  type: "ltd",
  jurisdiction: "england-wales",
  sic_codes: ["12345", "67890"],
  registered_office_address: {
    address_line_1: "1 High Street",
    locality: "London",
    postal_code: "EC1A 1AA",
    country: "England",
  },
  accounts: {
    accounting_reference_date: { day: "31", month: "03" },
    last_accounts: { made_up_to: "2024-03-31", type: "full" },
    next_due: "2024-12-31",
  },
  has_charges: true,
};

const CHARGES: ChargesList = {
  total_count: 1,
  unfiled_count: 0,
  items: [
    {
      charge_number: 1,
      classification: { description: "Fixed and floating charge" },
      persons_entitled: [{ name: "Barclays Bank PLC" }],
      status: "outstanding",
      created_on: "2015-04-01",
      secured_details: { description: "All monies due or to become due." },
    },
  ],
};

const SEARCH: CompanySearchResult = {
  total_results: 1,
  items: [
    {
      company_number: "12345678",
      title: "ACME WIDGETS LIMITED",
      company_status: "active",
      company_type: "ltd",
      address_snippet: "1 High Street, London, EC1A 1AA",
    },
  ],
};

// --- Global fetch mock -------------------------------------------------------

function jsonResponse(data: unknown, status = 200): Response {
  const text = JSON.stringify(data);
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => data,
    text: async () => text, // the size-capped fetch reads text then parses, like a real Response
    headers: new Headers({ "content-length": String(text.length) }),
    body: null,
  } as unknown as Response;
}

function installFetchMock() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/search/companies")) return jsonResponse(SEARCH);
    if (url.includes("/charges")) return jsonResponse(CHARGES);
    if (url.includes("/company/")) return jsonResponse(PROFILE);
    throw new Error(`unexpected url ${url}`);
  }) as typeof fetch;
}

// --- Async setup, awaited by the runner before run() -------------------------

let manifest: FactManifest;
let sheet: TearSheet;
let search: CompanySearchResult;
let missingKeyMessage = "";

export async function registerLiveTests(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.CH_API_KEY;
  installFetchMock();

  process.env.CH_API_KEY = "demo-key";
  manifest = await buildLiveFactManifest("12345678");
  sheet = await assembleLiveTearSheet("12345678");
  search = await searchCompanies("acme");

  // Missing key must throw the typed error before any network call.
  delete process.env.CH_API_KEY;
  try {
    await buildLiveFactManifest("12345678");
  } catch (err) {
    missingKeyMessage = (err as Error).message;
  }

  // Restore environment.
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.CH_API_KEY;
  else process.env.CH_API_KEY = originalKey;

  registerCases();
}

// --- Assertions --------------------------------------------------------------

function registerCases() {
  suite("companiesHouseLive / structured facts");

  test("sector derives from SIC codes at R1", () => {
    const f = manifest.facts["sector.FY2024"];
    assertEqual(f.rung, "R1", "reported structured field");
    assertEqual(f.value, "12345, 67890", "SIC codes joined");
    assert(!!f.provenance && f.provenance.tag === "Reg", "register provenance tag");
  });

  test("geography derives from the registered office country", () => {
    const f = manifest.facts["geography.FY2024"];
    assertEqual(f.value, "England", "registered office country");
  });

  test("incorporation and accounts reference map at R1", () => {
    assertEqual(manifest.facts["incorporation.FY2024"].value, "2001-06-15", "date of creation");
    assert(
      String(manifest.facts["accountsReference.FY2024"].value).includes("2024-03-31"),
      "accounts made-up-to date present"
    );
  });

  test("provenance points at the real public record URL", () => {
    const p = manifest.facts["sector.FY2024"].provenance!;
    assert(
      p.locator.includes("find-and-update.company-information.service.gov.uk/company/12345678"),
      "public record URL"
    );
    assert(!!p.retrievedAt, "retrievedAt present");
    assert(p.contentHash.startsWith("fnv1a:"), "content hash present");
  });

  suite("companiesHouseLive / charges -> capital structure");

  test("a charge maps to a secured-debt fact with chargee, status and description", () => {
    const f = manifest.facts["charge1.FY2024"];
    assertEqual(f.rung, "R1", "reported from the register");
    assertEqual(f.label, "Fixed and floating charge", "classification description");
    assertEqual(f.value, "Outstanding", "charge status carried as the value");
    assert(!!f.provenance && f.provenance.tag === "NF", "charges register tag");
    assert(f.provenance!.snippet.includes("Barclays Bank PLC"), "chargee (persons_entitled)");
  });

  test("the charge renders as a capital tranche via the reused assemble pipeline", () => {
    assertEqual(sheet.capital.length, 1, "one tranche from one charge");
    assert(sheet.capital[0].provider.includes("Barclays Bank PLC"), "chargee is the provider");
  });

  suite("companiesHouseLive / financial honesty");

  test("turnover / EBITDA / leverage abstain at R4 with an attempt log", () => {
    for (const metric of ["turnover", "ebitda", "leverage"]) {
      const f = manifest.facts[`${metric}.FY2024`];
      assertEqual(f.rung, "R4", `${metric} abstains`);
      assertEqual(f.value, null, `${metric} invents no number`);
      assert(!!f.attemptLog && f.attemptLog.length > 0, `${metric} keeps an attempt log`);
    }
    const log = manifest.facts["turnover.FY2024"].attemptLog!;
    assert(
      log.some((e) => e.detail.includes("accounts filing")),
      "log points to the accounts filing / document parser"
    );
  });

  test("the live entity is marked real, not synthetic", () => {
    assertEqual(manifest.entity.synthetic, false, "live record is not synthetic");
    assertEqual(manifest.entity.companyNumber, "12345678", "company number");
    assertEqual(manifest.entity.accountsType, "full", "accounts type from last_accounts");
  });

  suite("companiesHouseLive / search + auth");

  test("search returns live register matches", () => {
    assertEqual(search.items[0].company_number, "12345678", "search hit");
  });

  test("missing CH_API_KEY throws the typed error", () => {
    assertEqual(missingKeyMessage, "CH_API_KEY not set", "typed error message");
  });

  test("mapLiveToManifest is a pure mapper (no fetch, no key required)", () => {
    const m = mapLiveToManifest(PROFILE, CHARGES);
    assertEqual(m.facts["sector.FY2024"].value, "12345, 67890", "pure map matches fetched map");
  });

  test("a genuine clean insolvency register lands no data-gap marker", () => {
    const m = mapLiveToManifest(PROFILE, CHARGES, { insolvencyFetchFailed: false });
    assert(!Object.keys(m.facts).some((k) => k.startsWith("dataGap.insolvency")), "no gap marker on a clean 404");
  });

  test("an insolvency fetch failure lands an honest data-gap marker, not a silent clean register", () => {
    const m = mapLiveToManifest(PROFILE, CHARGES, { insolvencyFetchFailed: true });
    const gap = Object.values(m.facts).find((f) => f.metric === "dataGap.insolvency");
    assert(!!gap, "the fetch failure is recorded as a data gap");
    assertEqual(gap!.rung, "R4", "recorded as an R4 abstain, never a clean answer");
    assert(String(gap!.value).toLowerCase().includes("unverified"), "the marker says the absence is unverified");
    assert(!gap!.metric.startsWith("insolvency."), "namespaced dataGap.*, never mistaken for a filed case");
  });
}
