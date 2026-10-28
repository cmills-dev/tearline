// test/runEntry.test.ts
// The one run entry (WP-FE02): what the field reads a typed value as, and what submitting it
// does against the run API. No network and no model. The API is a fake whose answers come from
// the real resolver and the real run job, driven by the WP-BE02 register fixtures in
// fixtures/resolve, so every company, number and reason asserted here is one the register
// returned when the fixtures were recorded. The builder is a stub that refuses, so no run here
// reads a filing: these tests are about who gets run, not what the sheet says.

import { existsSync, readdirSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { suite, test, assert, assertEqual } from "./harness";
import { resolveLei } from "../lib/sources/gleif";
import type { ResolveClient } from "../lib/resolve/types";
import { InMemoryRunStore } from "../lib/run/store";
import { createRun, executeRun } from "../lib/run/runner";
import { runView } from "../lib/run/view";
import { candidatesAnswer } from "../lib/resolve/candidates";
import { HIDDEN_ROUTES } from "../lib/config/launchRoutes";
import {
  candidateFacts,
  entryHint,
  lookupCandidates,
  parseRunPoll,
  pickCandidate,
  pollRun,
  readEntry,
  runToPoll,
  stateFromRun,
  submitEntry,
  type EntryState,
  type FetchLike,
  type RunPoll,
} from "../app/components/runEntryFlow";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures", "resolve");
const APP = join(HERE, "..", "app");

interface ExpectedCase {
  slug: string;
  input: string;
  kind: string;
  number: string | null;
  name: string | null;
}
const EXPECTED = (JSON.parse(readFileSync(join(FIX, "expected.json"), "utf8")) as { cases: ExpectedCase[] }).cases;
const SLUGS = readdirSync(FIX).filter((f) => !f.endsWith(".json"));

function jsonRes(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

// The recorded file for a lookup. A name search is served from that input's own folder; a
// profile or filing history for a number from whichever folder recorded it. A lookup nobody
// recorded throws, so a test cannot pass on a response that was never on the register.
function recorded(file: string, prefer?: string): string {
  const dirs = prefer ? [prefer, ...SLUGS] : SLUGS;
  for (const d of dirs) {
    const path = join(FIX, d, file);
    if (existsSync(path)) return path;
  }
  throw new Error(`fixture not recorded: ${file}`);
}

function fixtureClient(slug?: string): ResolveClient {
  const gleifFetch = (async (url: string) => {
    const m = /registeredAs\]=([^&]+)/.exec(url);
    if (!m) return jsonRes(404, null);
    try {
      return jsonRes(200, readJson(recorded(`gleif-${decodeURIComponent(m[1])}.json`, slug)));
    } catch {
      return jsonRes(404, null);
    }
  }) as unknown as typeof fetch;
  return {
    async search() {
      if (!slug) throw new Error("a number input must not search the register");
      return readJson(join(FIX, slug, "search.json")) as Awaited<ReturnType<ResolveClient["search"]>>;
    },
    async profile(n) {
      return readJson(recorded(`profile-${n}.json`, slug)) as Awaited<ReturnType<ResolveClient["profile"]>>;
    },
    async filingHistory(n) {
      return (readJson(recorded(`filings-${n}.json`, slug)) as { items: Awaited<ReturnType<ResolveClient["filingHistory"]>> }).items;
    },
    async leiForCompanyNumber(n) {
      const rec = await resolveLei(n, { chNumber: n, fetchImpl: gleifFetch });
      return rec?.lei ?? null;
    },
  };
}

function slugFor(input: string): string | undefined {
  return EXPECTED.find((c) => c.input === input)?.slug;
}

// A fake of the three routes the entry calls. POST /api/run creates a run and, unlike the real
// route, finishes it before answering, so the first poll reads a terminal record. The answer
// itself has the real route's shape. GET /api/resolve/candidates exists only when asked for.
interface FakeApi {
  fetch: FetchLike;
  calls: string[];
  runInputs: string[];
}

function fakeApi(opts: { candidatesRoute: boolean; status?: number; error?: string }): FakeApi {
  const store = new InMemoryRunStore();
  const calls: string[] = [];
  const runInputs: string[] = [];
  const tenant = "entry-tests";
  let n = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (opts.status) return jsonRes(opts.status, opts.error ? { error: opts.error } : null);

    if (url.startsWith("/api/resolve/candidates")) {
      if (!opts.candidatesRoute) return jsonRes(404, null);
      const q = new URL(url, "http://x").searchParams.get("q") ?? "";
      return jsonRes(200, await candidatesAnswer(q, fixtureClient(slugFor(q))));
    }

    if (url === "/api/run" && method === "POST") {
      const input = String((JSON.parse(String(init?.body)) as { input: string }).input);
      runInputs.push(input);
      const deps = {
        store,
        resolveClient: fixtureClient(slugFor(input)),
        newId: () => `run-${++n}`,
        build: async () => {
          throw new Error("stub builder: this suite does not read filings");
        },
      };
      const run = await createRun(tenant, input, deps);
      await executeRun(run, deps);
      return jsonRes(202, {
        id: run.id,
        status: run.status,
        input: run.input,
        startedAt: run.startedAt,
        stages: run.stages,
        poll: `/api/run/${run.id}`,
        durable: false,
      });
    }

    const m = /^\/api\/run\/([^/]+)$/.exec(url);
    if (m && method === "GET") {
      const run = await store.load(tenant, decodeURIComponent(m[1]));
      if (!run) return jsonRes(404, { error: "No such run." });
      return jsonRes(200, runView(run, false));
    }
    return jsonRes(404, null);
  };
  return { fetch: fetchImpl, calls, runInputs };
}

// Submit, then poll as the component does until nothing is left to poll.
async function settle(state: EntryState, api: FakeApi): Promise<EntryState> {
  let s = state;
  for (let i = 0; i < 10; i++) {
    const p = runToPoll(s);
    if (!p) return s;
    s = await pollRun(p.id, p.input, api.fetch);
  }
  throw new Error("the run never reached a terminal state");
}

function expectedCase(slug: string): ExpectedCase {
  const c = EXPECTED.find((x) => x.slug === slug);
  if (!c) throw new Error(`no expected case ${slug}`);
  return c;
}

export async function registerRunEntryTests(): Promise<void> {
  suite("run entry / reading the field");

  test("an 8-digit number is a number and starts a run", () => {
    const r = readEntry("00445790");
    assert(r.kind === "number" && r.number === "00445790", JSON.stringify(r));
    assert(/starts a run directly/.test(entryHint(r)), "the hint says a run starts");
  });

  test("a 6 or 7 digit number is zero-padded, as people drop the leading zeros", () => {
    const r = readEntry("445790");
    assert(r.kind === "number" && r.number === "00445790", JSON.stringify(r));
  });

  test("SC, NI and OC numbers are numbers, in any case and with spaces", () => {
    for (const [raw, number] of [
      ["SC002934", "SC002934"],
      ["sc 002934", "SC002934"],
      ["NI004842", "NI004842"],
      ["ni004842", "NI004842"],
      ["OC343897", "OC343897"],
      ["  oc 343 897  ", "OC343897"],
    ]) {
      const r = readEntry(raw);
      assert(r.kind === "number" && r.number === number, `${raw} reads as ${number}, got ${JSON.stringify(r)}`);
    }
  });

  test("LLP numbers from every UK register are numbers (OC, SO, NC)", () => {
    for (const raw of ["OC343897", "so301234", "NC000123"]) {
      const r = readEntry(raw);
      assert(r.kind === "number" && /LLP/.test(r.register), `${raw} is an LLP number: ${JSON.stringify(r)}`);
    }
  });

  test("an LLP typed by name is a name, not a number", () => {
    const r = readEntry(expectedCase("irwin-mitchell-llp").input);
    assertEqual(r.kind, "name", "a name ending LLP is looked up by name");
  });

  test("overseas registrations are refused in the field, with the reason, before any call", () => {
    for (const slug of ["number-br014816", "number-fc031481"]) {
      const r = readEntry(expectedCase(slug).input);
      assert(r.kind === "excluded", `${slug} is excluded`);
      assert(/overseas|branch/.test(entryHint(r)), `the hint gives the reason: ${entryHint(r)}`);
    }
  });

  test("names, near-numbers and blank input", () => {
    for (const raw of ["Tesco", "tesco  plc", "12345", "123456789", "SC12345"]) {
      assertEqual(readEntry(raw).kind, "name", `${raw} is a name`);
    }
    assertEqual(readEntry("   ").kind, "empty", "whitespace is empty");
    assertEqual(readEntry("tesco   plc").kind === "name" && (readEntry("tesco   plc") as { name: string }).name, "tesco plc", "runs of spaces collapse");
  });

  test("the field and its hints hold no fixture names or numbers", () => {
    const sources = ["components/EntryField.tsx", "components/RunEntry.tsx", "components/runEntryFlow.ts"].map(
      (f) => [f, readFileSync(join(APP, f), "utf8").toLowerCase()] as const,
    );
    const hints = (["empty", "name"] as const).map((k) => entryHint(k === "empty" ? { kind: "empty" } : { kind: "name", name: "x" }).toLowerCase());
    for (const c of EXPECTED) {
      const needles = [c.input, c.name, c.number].filter((s): s is string => !!s && s.length > 3).map((s) => s.toLowerCase());
      for (const needle of needles) {
        for (const [file, text] of sources) assert(!text.includes(needle), `${file} names the fixture "${needle}"`);
        for (const h of hints) assert(!h.includes(needle), `a hint names the fixture "${needle}"`);
      }
    }
  });

  test("the home page links to no route hidden at launch", () => {
    // The routes WP-FE01 returns 404 for in production, from their single source.
    const hidden = HIDDEN_ROUTES;
    for (const f of ["page.tsx", "components/EntryField.tsx", "components/RunEntry.tsx"]) {
      const text = readFileSync(join(APP, f), "utf8");
      for (const route of hidden) {
        assert(!new RegExp(`["'\`]${route}(["'\`/?#])`).test(text), `${f} links to ${route}`);
      }
    }
  });

  suite("run entry / numbers start a run directly");

  for (const [slug, number] of [
    ["number-445790", "00445790"],
    ["number-sc002934", "SC002934"],
    ["number-ni004842", "NI004842"],
    ["number-oc343897", "OC343897"],
  ] as const) {
    const api = fakeApi({ candidatesRoute: true });
    const typed = number === "00445790" ? "00445790" : expectedCase(slug).input;
    const first = await submitEntry(typed, api.fetch);
    const end = await settle(first, api);
    test(`${typed} posts a run for ${number} with no name lookup`, () => {
      assertEqual(JSON.stringify(api.runInputs), JSON.stringify([number]), "one run, by the canonical number");
      assert(!api.calls.some((c) => c.includes("/api/resolve/candidates")), "no candidates lookup for a number");
      assertEqual(first.phase, "looking", "the first answer is the register lookup of a live run");
      assert(runToPoll(first) !== null, "and it is polled");
    });
    test(`${typed} resolves to ${number} on the register before the (stubbed) builder`, () => {
      assert(end.phase === "stopped", `ends where the stub builder refuses, got ${end.phase}`);
      if (end.phase === "stopped") {
        assertEqual(end.run.companyNumber, number, "the run names the typed company");
        const resolve = end.run.stages.find((s) => s.stage === "resolve");
        assertEqual(resolve?.status, "done", "the resolve stage finished");
      }
    });
  }

  suite("run entry / names show register candidates");

  {
    // With the candidates route the backend lane is asked for (docs/programme/reports/WP-FE02.md).
    const api = fakeApi({ candidatesRoute: true });
    const tesco = expectedCase("tesco");
    const shown = await submitEntry(tesco.input, api.fetch);
    const runsBeforePick = api.runInputs.length;
    test("a name shows the register's candidates and starts nothing yet", () => {
      assert(shown.phase === "pick", `pick list, got ${shown.phase}`);
      if (shown.phase === "pick") {
        assert(shown.candidates.some((c) => c.number === tesco.number), "the intended company is on the list");
        assert(shown.reason.length > 0, "the resolver's reason is shown");
      }
      assertEqual(runsBeforePick, 0, "no run before a pick");
    });
    const picked = shown.phase === "pick" ? shown.candidates.find((c) => c.number === tesco.number)! : null;
    const afterPick = picked ? await settle(await pickCandidate(picked, api.fetch), api) : null;
    test("picking a candidate starts a run by its number, never its name", () => {
      assertEqual(JSON.stringify(api.runInputs), JSON.stringify([tesco.number]), "one run, by number");
      assert(afterPick?.phase === "stopped" && afterPick.run.companyNumber === tesco.number, "the run is for the picked company");
    });
  }

  {
    const api = fakeApi({ candidatesRoute: true });
    const wilko = expectedCase("wilko");
    const shown = await submitEntry(wilko.input, api.fetch);
    test("an ambiguous name always shows a pick list holding the intended company", () => {
      assert(shown.phase === "pick" && shown.candidates.length > 1, `a list of more than one, got ${JSON.stringify(shown).slice(0, 200)}`);
      if (shown.phase === "pick") {
        assert(shown.candidates.slice(0, 5).some((c) => c.number === wilko.number), "intended company in the top five");
        assertEqual(shown.candidates.filter((c) => c.suggested).length, 1, "one candidate marked as ranked first");
      }
    });
  }

  {
    // The route's own answer (lib/resolve/candidates.ts, served by GET /api/resolve/candidates).
    const tesco = expectedCase("tesco");
    const a = await candidatesAnswer(tesco.input, fixtureClient(tesco.slug));
    const nonsense = expectedCase("nonsense");
    const none = await candidatesAnswer(nonsense.input, fixtureClient(nonsense.slug));
    test("the candidates answer lists a clear match as one suggested candidate, with the resolver's reason", () => {
      assertEqual(a.kind, "resolved", "kind");
      assertEqual(a.candidates.length, 1, "one candidate");
      assertEqual(a.candidates[0].number, tesco.number, "the register's number");
      assert(a.candidates[0].suggested && a.suggested === tesco.number, "marked as suggested");
      assert(a.reason.length > 0, "the resolver's reason is kept");
    });
    test("a name the register does not know is an empty list with its reason, never a guess", () => {
      assertEqual(none.kind, "none", "kind");
      assertEqual(none.candidates.length, 0, "no candidates");
      assertEqual(none.suggested, null, "nothing suggested");
    });
    test("the candidates route exists and reads nothing but the resolver", () => {
      const text = readFileSync(join(APP, "api", "resolve", "candidates", "route.ts"), "utf8");
      assert(/export async function GET/.test(text), "GET handler");
      assert(!/createRun|executeRun|runStore|getRunStore/.test(text), "no run is created");
      assert(/resolve:tenant/.test(text) && /resolve:ip/.test(text), "its own throttle buckets");
    });
  }

  suite("run entry / names without the candidates route");

  {
    // Until the backend ships GET /api/resolve/candidates, the name goes to POST /api/run and the
    // run's own resolver decides: a clear match runs, an ambiguous one stops at needs-choice.
    const api = fakeApi({ candidatesRoute: false });
    const wilko = expectedCase("wilko");
    const end = await settle(await submitEntry(wilko.input, api.fetch), api);
    test("a 404 on the candidates route falls back to a run by name", () => {
      assert(api.calls[0].startsWith("GET /api/resolve/candidates"), "tried the lookup first");
      assertEqual(JSON.stringify(api.runInputs), JSON.stringify([wilko.input]), "then a run by name");
    });
    test("the run's needs-choice ending becomes the pick list, and a pick runs by number", async () => {
      assert(end.phase === "pick", `pick list, got ${end.phase}`);
      if (end.phase !== "pick") return;
      assert(end.candidates.some((c) => c.number === wilko.number), "intended company on the list");
      const after = await settle(await pickCandidate(end.candidates.find((c) => c.number === wilko.number)!, api.fetch), api);
      assertEqual(api.runInputs[1], wilko.number, "second run is by number");
      assert(after.phase === "stopped" && after.run.companyNumber === wilko.number, "for the picked company");
    });
  }

  {
    const api = fakeApi({ candidatesRoute: false });
    const tesco = expectedCase("tesco");
    const end = await settle(await submitEntry(tesco.input, api.fetch), api);
    test("a clear match runs straight through the resolver when there is no candidates route", () => {
      assert(end.phase === "stopped" && end.run.companyNumber === tesco.number, `ran ${tesco.number}, got ${end.phase}`);
    });
  }

  suite("run entry / no match is an answer");

  for (const route of [true, false]) {
    const api = fakeApi({ candidatesRoute: route });
    const nonsense = expectedCase("nonsense");
    const end = await settle(await submitEntry(nonsense.input, api.fetch), api);
    test(`nonsense gives the no-match state with the resolver's reason (${route ? "lookup" : "run"} path)`, () => {
      assert(end.phase === "no-match", `no-match, got ${end.phase}`);
      if (end.phase === "no-match") assert(/none carries every word/.test(end.reason), `reason: ${end.reason}`);
    });
  }

  {
    const api = fakeApi({ candidatesRoute: true });
    const end = await submitEntry(expectedCase("number-fc031481").input, api.fetch);
    test("an overseas number is a no-match with its reason and makes no call", () => {
      assert(end.phase === "no-match" && /overseas/.test(end.reason), JSON.stringify(end));
      assertEqual(api.calls.length, 0, "no request");
    });
  }

  test("an empty submit does nothing", async () => {
    const api = fakeApi({ candidatesRoute: true });
    assertEqual((await submitEntry("  ", api.fetch)).phase, "idle", "idle");
    assertEqual(api.calls.length, 0, "no request");
  });

  suite("run entry / when a run cannot start");

  test("signed out: the server's own sentence, not a no-match", async () => {
    const api = fakeApi({ candidatesRoute: true, status: 401, error: "You must be signed in." });
    const s = await submitEntry("00445790", api.fetch);
    assert(s.phase === "unavailable" && s.message === "You must be signed in.", JSON.stringify(s));
  });

  test("no register key: the setup gap is said plainly", async () => {
    const api = fakeApi({ candidatesRoute: true, status: 503, error: "A run needs CH_API_KEY (free from Companies House). Without it nothing can be looked up." });
    const s = await submitEntry("00445790", api.fetch);
    assert(s.phase === "unavailable" && /CH_API_KEY/.test(s.message), JSON.stringify(s));
  });

  test("an error from the candidates route is shown, not treated as a missing route", async () => {
    const api = fakeApi({ candidatesRoute: true, status: 429 });
    const r = await lookupCandidates("anything", api.fetch);
    assert(r.available && r.state.phase === "unavailable", JSON.stringify(r));
  });

  test("a network failure is unavailable, not a no-match", async () => {
    const s = await submitEntry("00445790", async () => {
      throw new Error("offline");
    });
    assertEqual(s.phase, "unavailable", "unavailable");
  });

  suite("run entry / reading a run");

  const base: RunPoll = {
    id: "r",
    input: "x",
    status: "running",
    stages: [],
    currentStage: null,
    elapsedMs: 0,
    companyName: null,
    companyNumber: null,
    sheetKey: null,
    candidates: null,
    reason: null,
    durable: true,
    pollAfterMs: 1000,
  };

  test("done with a sheet key opens the sheet; done without one is not claimed as done", () => {
    const done = stateFromRun({ ...base, status: "done", sheetKey: "ch-key", pollAfterMs: null });
    assert(done.phase === "done" && done.sheetKey === "ch-key", JSON.stringify(done));
    assertEqual(stateFromRun({ ...base, status: "done", pollAfterMs: null }).phase, "stopped", "no key, no sheet");
    assertEqual(runToPoll(done), null, "a terminal run is not polled");
  });

  test("partial is stopped with the run's own reason", () => {
    const s = stateFromRun({ ...base, status: "partial", reason: "extract timed out" });
    assert(s.phase === "stopped" && s.reason === "extract timed out", JSON.stringify(s));
  });

  test("once the resolver names a company the run is running, and polled", () => {
    const s = stateFromRun({
      ...base,
      companyNumber: "N",
      stages: [{ stage: "resolve", status: "done", detail: "", startedAt: null, endedAt: null, elapsedMs: 1 }],
    });
    assertEqual(s.phase, "running", "running");
    assertEqual(runToPoll(s)?.id, "r", "polled");
  });

  test("a body that is not a run view is not read as one", () => {
    assertEqual(parseRunPoll({ error: "No such run." }), null, "error body");
    assertEqual(parseRunPoll({ id: "r", status: "exploded" }), null, "unknown status");
  });

  test("candidate lines leave out what the register did not give", () => {
    const line = candidateFacts({
      number: "N1",
      name: "A",
      status: "active",
      type: "ltd",
      incorporatedOn: null,
      locality: null,
      lastAccountsMadeUpTo: null,
      hasAccountsFiling: null,
      matchedPreviousName: null,
      why: [],
      suggested: false,
    });
    assertEqual(line, "No. N1 · ltd · active", "only the fields present");
  });
}
