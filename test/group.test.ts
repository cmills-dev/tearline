// test/group.test.ts
// Group following (WP-BE12, audit BE-05). Every register and GLEIF answer here is a recorded
// read, captured live on Tue 22 Sep 2026 into test/fixtures/group/ with no model call:
//   profile-<n>.json    GET /company/<n>
//   psc-<n>.json        GET /company/<n>/persons-with-significant-control
//   filings-<n>.json    GET /company/<n>/filing-history?category=accounts
//   gleif-ch-<n>.json   GLEIF lei-records filtered by registeredAs=<n>, country GB
//   gleif-<kind>-<lei>.json  GLEIF direct-parent / ultimate-parent (a 404 body when none)
// A file that was not recorded answers as the register would for a missing record.
//
// The builder is a stub that stands in for buildLiveFactManifest: the figures themselves come
// from the existing, separately tested builder. What is proved here is that the builder is
// pointed at the parent's group filing, and that what comes back is labelled and cited as the
// parent group's.

import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { suite, test, assert, assertEqual } from "./harness";
import {
  controllingCorporate,
  createGroupClient,
  followToGroup,
  isUkRegistered,
  normaliseChNumber,
  shouldFollow,
  type GroupClient,
  type GroupFollowing,
  type PscEntry,
} from "../lib/resolve/group";
import { withGroupFollowing, GROUP_SOURCE, type GroupManifest } from "../lib/run/stages/group";
import { runToCompletion } from "../lib/run/runner";
import { InMemoryRunStore } from "../lib/run/store";
import type { RunRecord } from "../lib/run/types";
import type { ChFilingItem, ChProfile, ChSearchResult, ResolveClient } from "../lib/resolve/types";
import type { FactManifest } from "../lib/engine/types";
import type { BuildLiveOptions } from "../lib/sources/companiesHouseLive";
import { selectLatestAccountsFiling } from "../lib/resolve/filings";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "fixtures", "group");
const TENANT = "group-tests";

export function recorded<T>(file: string): T | null {
  const p = join(DIR, file);
  if (!existsSync(p)) return null;
  const body = JSON.parse(readFileSync(p, "utf8")) as T & { errors?: unknown };
  // The register answers a missing record with {"errors": [...]}; that is a 404.
  if (body && typeof body === "object" && "errors" in body) return null;
  return body;
}

// GLEIF, replayed by URL. Anything not recorded answers 404, as GLEIF does at the top of a tree.
function gleifReplay(calls: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = decodeURIComponent(String(input));
    calls.push(url);
    let file: string | null = null;
    const byCh = /filter\[entity\.registeredAs\]=([A-Z0-9]+)/.exec(url);
    const rel = /\/lei-records\/([A-Z0-9]{20})\/(direct-parent|ultimate-parent)$/.exec(url);
    if (byCh) file = `gleif-ch-${byCh[1]}.json`;
    else if (rel) file = `gleif-${rel[2]}-${rel[1]}.json`;
    const body = file ? recorded<{ data?: unknown }>(file) : null;
    const ok = body !== null && body.data !== undefined && body.data !== null;
    return {
      status: ok ? 200 : 404,
      ok,
      json: async () => body,
    } as unknown as Response;
  }) as typeof fetch;
}

// A GroupClient over the recorded files. The GLEIF half is the live client's own code, fed
// the recorded GLEIF answers, so the LEI and parent parsing are exercised as they run live.
export class RecordedGroupClient implements GroupClient {
  calls: string[] = [];
  gleifCalls: string[] = [];
  private readonly gleif = createGroupClient({ gleifFetch: gleifReplay(this.gleifCalls) });

  constructor(private readonly tamper: (n: string, items: PscEntry[]) => PscEntry[] = (_n, i) => i) {}

  async profile(n: string): Promise<ChProfile | null> {
    this.calls.push(`profile ${n}`);
    return recorded<ChProfile>(`profile-${n}.json`);
  }
  async filingHistory(n: string): Promise<ChFilingItem[]> {
    this.calls.push(`filings ${n}`);
    return recorded<{ items?: ChFilingItem[] }>(`filings-${n}.json`)?.items ?? [];
  }
  async psc(n: string): Promise<PscEntry[]> {
    this.calls.push(`psc ${n}`);
    return this.tamper(n, recorded<{ items?: PscEntry[] }>(`psc-${n}.json`)?.items ?? []);
  }
  leiForCompanyNumber(n: string) {
    this.calls.push(`lei ${n}`);
    return this.gleif.leiForCompanyNumber(n);
  }
  gleifParent(lei: string, kind: "direct-parent" | "ultimate-parent") {
    this.calls.push(`gleif ${kind} ${lei}`);
    return this.gleif.gleifParent(lei, kind);
  }
}

// The resolver's client over the same recorded files, for runs started with a number.
class RecordedResolveClient implements ResolveClient {
  async search(): Promise<ChSearchResult> {
    return { items: [], total_results: 0 };
  }
  async profile(n: string) {
    return recorded<ChProfile>(`profile-${n}.json`);
  }
  async filingHistory(n: string) {
    return recorded<{ items?: ChFilingItem[] }>(`filings-${n}.json`)?.items ?? [];
  }
  async leiForCompanyNumber() {
    return null;
  }
}

// Stands in for buildLiveFactManifest. Builds a one-fact manifest for whatever number it is
// given, from that company's recorded profile and latest accounts filing, and records the call.
function stubBuilder(calls: string[]) {
  return async (number: string, options: BuildLiveOptions): Promise<FactManifest> => {
    calls.push(number);
    const profile = recorded<ChProfile>(`profile-${number}.json`)!;
    const filing = selectLatestAccountsFiling(recorded<{ items?: ChFilingItem[] }>(`filings-${number}.json`)?.items ?? []);
    options.onStage?.({ stage: "resolve", status: "start", detail: `filing ${filing?.transactionId}`, at: new Date().toISOString() });
    options.onStage?.({ stage: "resolve", status: "done", detail: `filing ${filing?.transactionId}`, at: new Date().toISOString() });
    for (const stage of ["fetch", "extract", "verify", "assemble"] as const) {
      options.onStage?.({ stage, status: "start", detail: stage, at: new Date().toISOString() });
      options.onStage?.({ stage, status: "done", detail: stage, at: new Date().toISOString() });
    }
    const documentName = `Accounts made up to ${filing?.madeUpDate}`;
    return {
      entity: {
        companyName: profile.company_name,
        companyNumber: profile.company_number,
        jurisdiction: profile.jurisdiction ?? "",
        status: profile.company_status ?? "",
        incorporatedOn: profile.date_of_creation ?? "",
        sicCodes: [],
        registeredOffice: "",
        accountsType: filing?.accountsType ?? "unknown",
        latestPeriodEnd: filing?.madeUpDate ?? "",
        synthetic: false,
      },
      facts: {
        "revenue.FY": {
          id: "revenue.FY",
          metric: "revenue",
          label: "Revenue",
          period: "FY",
          kind: "currency",
          value: 1,
          unit: "GBP",
          rung: "R1",
          provenance: {
            sourceId: "ch-accounts",
            tag: "Acc",
            documentName,
            locator: `filing ${filing?.transactionId}`,
            snippet: "1",
            retrievedAt: "2026-09-22",
            contentHash: "stub",
          },
          verification: { status: "verified", checks: [] },
        },
      },
      sources: {
        "ch-accounts": {
          sourceId: "ch-accounts",
          tag: "Acc",
          documentName,
          retrievedAt: "2026-09-22",
          origin: `Companies House filing history, ${filing?.transactionId}`,
        },
      },
      generatedAt: "2026-09-22T00:00:00Z",
    } as unknown as FactManifest;
  };
}

interface Ran {
  run: RunRecord;
  manifest: GroupManifest | null;
  builtFor: string[];
}

async function runGroup(input: string, client: GroupClient = new RecordedGroupClient(), follow?: { routes?: ("psc" | "gleif")[] }): Promise<Ran> {
  const builtFor: string[] = [];
  let manifest: GroupManifest | null = null;
  const run = await runToCompletion(TENANT, input, {
    store: new InMemoryRunStore(),
    resolveClient: new RecordedResolveClient(),
    build: withGroupFollowing(stubBuilder(builtFor), { client, follow }),
    persist: async (_t, _k, m) => {
      manifest = m as GroupManifest;
    },
  });
  return { run, manifest, builtFor };
}

function found(f: GroupFollowing): Extract<GroupFollowing, { kind: "found" }> {
  if (f.kind !== "found") throw new Error(`expected a parent group, got none: ${f.reason}`);
  return f;
}

function latestGroupTransaction(number: string): string {
  const f = selectLatestAccountsFiling(recorded<{ items?: ChFilingItem[] }>(`filings-${number}.json`)?.items ?? []);
  return f!.transactionId;
}

// --- Results, gathered once --------------------------------------------------------------

let pret: GroupFollowing;
let wagamama: GroupFollowing;
let away: GroupFollowing;
let tescoByGleif: GroupFollowing;
let tescoByPsc: GroupFollowing;
let amazon: GroupFollowing;
let pretGleifOnly: GroupFollowing;
let mismatch: GroupFollowing;
let gleifClient: RecordedGroupClient;
let runs: Record<string, Ran> = {};

export async function registerGroupTests(): Promise<void> {
  pret = await followToGroup("11391321", new RecordedGroupClient());
  wagamama = await followToGroup("02605751", new RecordedGroupClient());
  away = await followToGroup("06458827", new RecordedGroupClient());
  gleifClient = new RecordedGroupClient();
  tescoByGleif = await followToGroup("00519500", gleifClient, { routes: ["gleif"] });
  tescoByPsc = await followToGroup("00519500", new RecordedGroupClient());
  amazon = await followToGroup("03223028", new RecordedGroupClient());
  pretGleifOnly = await followToGroup("11391321", new RecordedGroupClient(), { routes: ["gleif"] });
  // Synthetic: the Away Resorts PSC row renamed, so its number no longer matches its name.
  mismatch = await followToGroup(
    "06458827",
    new RecordedGroupClient((n, items) =>
      n === "06458827" ? items.map((p) => ({ ...p, name: "Sunshine Caravans Ltd" })) : items,
    ),
  );

  runs = {
    pret: await runGroup("11391321"),
    wagamama: await runGroup("02605751"),
    away: await runGroup("06458827"),
    amazon: await runGroup("03223028"),
    moyPark: await runGroup("NI004842"),
    tescoStores: await runGroup("00519500"),
    pretNoParent: await runGroup("11391321", new RecordedGroupClient(), { routes: ["gleif"] }),
    outage: await runGroup(
      "02605751",
      Object.assign(new RecordedGroupClient(), {
        psc: async () => {
          throw new Error("Companies House: rate limit exceeded (600 requests / 5 min).");
        },
      }),
    ),
  };

  registerCases();
}

function registerCases(): void {
  suite("group / reading the PSC register");

  test("a filer's registration number becomes a Companies House number", () => {
    assertEqual(normaliseChNumber("6486367"), "06486367", "Away Resorts Holdings as filed");
    assertEqual(normaliseChNumber("Ni70325"), "NI070325", "Moy Park Holdings (Europe) as filed");
    assertEqual(normaliseChNumber("SC 002934"), "SC002934", "a spaced Scottish number");
    assertEqual(normaliseChNumber("07556525"), "07556525", "already canonical");
    assertEqual(normaliseChNumber("4382726-DE"), null, "not a CH number");
    assertEqual(normaliseChNumber("123456789"), null, "too long");
    assertEqual(normaliseChNumber(undefined), null, "absent");
  });

  test("the UK register is recognised however the filer spelled it", () => {
    for (const place of ["Companies House", "Register Of Companies In The United Kingdom", "Uk Companies House", "The Registrar Of Companies In England And Wales"]) {
      assert(isUkRegistered({ place_registered: place }), place);
    }
    assert(!isUkRegistered({ place_registered: "Delaware", country_registered: "United States" }), "Delaware is not");
    assert(!isUkRegistered(undefined), "no identification is not");
  });

  test("a ceased PSC is ignored: Wagamama Limited's parent is Wagamama (Holdings), not Wagamama Group", () => {
    const items = recorded<{ items: PscEntry[] }>("psc-02605751.json")!.items;
    assertEqual(items.length, 2, "two corporate PSC rows are recorded");
    const got = controllingCorporate(items);
    assert("psc" in got, "one controlling parent");
    if ("psc" in got) assertEqual(got.psc.identification?.registration_number, "07556525", "the active one");
  });

  test("significant influence alone is not a parent: Apollo over Wagamama (Holdings)", () => {
    const got = controllingCorporate(recorded<{ items: PscEntry[] }>("psc-07556525.json")!.items);
    assert("none" in got, "no controlling parent");
    if ("none" in got) assert(got.none.includes("Apollo"), `names Apollo: ${got.none}`);
  });

  test("two controlling corporate shareholders is a joint venture, and no parent is picked", () => {
    const row = (name: string): PscEntry => ({
      name,
      kind: "corporate-entity-person-with-significant-control",
      natures_of_control: ["ownership-of-shares-50-to-75-percent"],
    });
    const got = controllingCorporate([row("A Ltd"), row("B Ltd")]);
    assert("none" in got && got.none.includes("no single parent"), "refuses to choose");
  });

  test("an audit-exempt subsidiary and a thin holding company are followed; a group or a trading company is not", () => {
    assert(shouldFollow({ name: "WAGAMAMA LIMITED", accountsType: "audit-exempt subsidiary" }, true).follow, "exempt subsidiary");
    assert(shouldFollow({ name: "TESCO HOLDINGS LIMITED", accountsType: "full" }, true).follow, "holding company");
    assert(shouldFollow({ name: "PRET UK LIMITED", accountsType: "dormant" }, true).follow, "dormant");
    assert(!shouldFollow({ name: "TESCO PLC", accountsType: "group" }, true).follow, "group");
    assert(!shouldFollow({ name: "TESCO STORES LIMITED", accountsType: "full" }, true).follow, "trading company with full accounts");
  });

  suite("group / walking to the parent group accounts");

  test("Pret A Manger Limited walks three steps up the PSC chain to Pret Parent Holding's group accounts", () => {
    const f = found(pret);
    assertEqual(f.parent.number, "13383544", "Pret Parent Holding Limited");
    assertEqual(f.parent.name, "PRET PARENT HOLDING LIMITED", "by the register's name");
    assertEqual(f.chain.map((c) => c.number).join(">"), "11391321>11417685>11415952>13383544", "the chain");
    assertEqual(f.parent.filing.accountsType, "group", "the parent's filing is group accounts");
    assertEqual(f.parent.filing.madeUpDate, "2026-01-01", "made up to 1 Jan 2026");
    assertEqual(f.parent.route, "psc", "by the PSC register");
    assert(f.chain.slice(1).every((c) => c.via?.evidence.startsWith("PSC register of")), "every step cites the PSC register");
  });

  test("Wagamama Limited is one step from Wagamama (Holdings) Limited's group accounts", () => {
    const f = found(wagamama);
    assertEqual(f.parent.number, "07556525", "Wagamama (Holdings) Limited");
    assertEqual(f.parent.filing.madeUpDate, "2025-12-28", "made up to 28 Dec 2025");
    assertEqual(f.chain.length, 2, "one step");
  });

  test("Away Resorts Limited reaches Artemis Bidco through a PSC number filed without its leading zero", () => {
    const f = found(away);
    assertEqual(f.chain.map((c) => c.number).join(">"), "06458827>06486367>13436242", "the chain");
    assertEqual(f.parent.name, "ARTEMIS BIDCO LIMITED", "the group");
    assertEqual(f.parent.filing.madeUpDate, "2025-12-31", "a year fresher than the subsidiary's own 2024 accounts");
  });

  test("the GLEIF route on its own: Tesco Stores' direct accounting parent is Tesco PLC", () => {
    const f = found(tescoByGleif);
    assertEqual(f.parent.number, "00445790", "Tesco PLC");
    assertEqual(f.parent.route, "gleif", "by GLEIF");
    assert(f.chain[1].via!.evidence.includes("2138002P5RNKC5W2JZ46"), "cites Tesco PLC's LEI");
    assert(!gleifClient.calls.some((c) => c.startsWith("psc")), "the PSC register was not read");
  });

  test("the PSC route reaches the same Tesco PLC through Tesco Holdings", () => {
    const f = found(tescoByPsc);
    assertEqual(f.chain.map((c) => c.number).join(">"), "00519500>00243011>00445790", "the chain");
  });

  test("a subsidiary with no findable parent says so: Amazon UK Services", () => {
    assertEqual(amazon.kind, "none", "no parent group");
    assert(amazon.reason.includes("Amazon.Com, Inc."), `names the controller: ${amazon.reason}`);
    assert(amazon.reason.includes("no registration details"), `says why the PSC route stopped: ${amazon.reason}`);
    assert(amazon.reason.includes("no LEI"), `says GLEIF had nothing either: ${amazon.reason}`);
  });

  test("an audit-exempt subsidiary whose GLEIF record names no parent says so", () => {
    assertEqual(pretGleifOnly.kind, "none", "no parent by GLEIF");
    assert(pretGleifOnly.reason.includes("54930052TMAP2DVNC649"), `names the LEI it checked: ${pretGleifOnly.reason}`);
  });

  test("a PSC number whose register name disagrees is not followed", () => {
    assertEqual(mismatch.kind, "none", "the link is refused");
    assert(mismatch.reason.includes("not trusted"), mismatch.reason);
  });

  suite("group / a run shows the parent group's figures");

  for (const [key, parentNumber, parentName, subjectName] of [
    ["pret", "13383544", "PRET PARENT HOLDING LIMITED", "PRET A MANGER LIMITED"],
    ["wagamama", "07556525", "WAGAMAMA (HOLDINGS) LIMITED", "WAGAMAMA LIMITED"],
    ["away", "13436242", "ARTEMIS BIDCO LIMITED", "AWAY RESORTS LIMITED"],
  ] as const) {
    test(`${subjectName}: the sheet is built from ${parentName}'s group accounts and labelled so`, () => {
      const { run, manifest, builtFor } = runs[key];
      assertEqual(run.status, "done", `status (reason: ${run.reason})`);
      assertEqual(builtFor.join(","), parentNumber, "the builder read the parent, and only the parent");
      assertEqual(run.companyNumber, parentNumber, "the run names the company whose filing it read");
      assert(run.companyName!.includes(`(group figures for ${subjectName})`), `run name: ${run.companyName}`);
      const g = manifest!.group!;
      assertEqual(g.basis, "parent-group", "labelled as group figures");
      assert(g.label.startsWith(`Group figures of ${parentName} ${parentNumber}`), g.label);
      if (g.basis !== "parent-group") return;
      assertEqual(g.subject.name, subjectName, "names the company that was asked for");
      assertEqual(g.parent.filing.transactionId, latestGroupTransaction(parentNumber), "cites the parent's latest group filing");
      assertEqual(g.parent.filing.accountsType, "group", "group accounts");
      assert(g.parent.publicUrl.endsWith(`/company/${parentNumber}/filing-history`), "links the parent's filing history");
    });

    test(`${subjectName}: every figure is cited to the parent filing`, () => {
      const m = runs[key].manifest!;
      for (const fact of Object.values(m.facts)) {
        if (!fact.provenance) continue;
        assert(
          fact.provenance.documentName.startsWith(`${parentName} ${parentNumber} (parent group): `),
          `${fact.id}: ${fact.provenance.documentName}`,
        );
        assert(fact.provenance.locator.includes(latestGroupTransaction(parentNumber)), "the parent's transaction");
      }
      assert(m.sources[GROUP_SOURCE].origin.includes(subjectName), "the chain is a source of its own");
    });

    test(`${subjectName}: the resolve row ends done after the group step`, () => {
      const row = runs[key].run.stages.find((s) => s.stage === "resolve")!;
      assertEqual(row.status, "done", "resolve ended done");
    });
  }

  test("a subsidiary with no findable parent keeps its own figures and says so", () => {
    const { run, manifest, builtFor } = runs.amazon;
    assertEqual(run.status, "done", `status (reason: ${run.reason})`);
    assertEqual(builtFor.join(","), "03223028", "its own filing");
    const g = manifest!.group!;
    assertEqual(g.basis, "own", "own figures");
    assert(g.label.includes("no parent group accounts could be found"), g.label);
    assert(g.reason.includes("Amazon.Com, Inc."), g.reason);
  });

  test("an exempt subsidiary with no findable parent says its own accounts are exempt ones", () => {
    const g = runs.pretNoParent.manifest!.group!;
    assertEqual(runs.pretNoParent.builtFor.join(","), "11391321", "its own filing");
    assertEqual(g.basis, "own", "own figures");
    assert(g.reason.includes("audit-exempt subsidiary"), g.reason);
  });

  test("a company with group accounts of its own is not walked: Moy Park", () => {
    const { manifest, builtFor } = runs.moyPark;
    assertEqual(builtFor.join(","), "NI004842", "its own filing");
    assertEqual(manifest!.group!.basis, "own", "own figures");
    assertEqual(manifest!.group!.chain.length, 0, "no walk was made");
  });

  test("a trading subsidiary keeps its own figures and names its parent group: Tesco Stores", () => {
    const g = runs.tescoStores.manifest!.group!;
    assertEqual(runs.tescoStores.builtFor.join(","), "00519500", "its own filing");
    assertEqual(g.basis, "own", "own figures");
    if (g.basis === "own") assertEqual(g.parentGroup?.number, "00445790", "Tesco PLC named");
  });

  test("a register outage during the group step does not fail the run", () => {
    const { run, manifest, builtFor } = runs.outage;
    assertEqual(run.status, "done", `status (reason: ${run.reason})`);
    assertEqual(builtFor.join(","), "02605751", "its own filing");
    assert(manifest!.group!.reason.includes("could not be looked up"), manifest!.group!.reason);
  });
}
