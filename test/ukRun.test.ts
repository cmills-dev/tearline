// test/ukRun.test.ts
// The UK eval gate (WP-BE13, eval/gold/uk-run.ts). No test makes a network call: global fetch is
// replaced by one that fails the test if anything reaches it.
//
// Bristol Water is the filing these tests replay. Its reads were re-recorded by eval:uk:live on
// 24 Sep 2026 under the current code, so every request is fingerprinted, which lets the tests
// prove the replay asks exactly what was recorded. The failure paths replay the same recording
// with one thing changed: a figure, a gold value, a version or a fingerprint.

import { suite, test, assert, assertEqual } from "./harness";
import { UK_GOLD, type UkGoldCase } from "../eval/gold/uk";
import { loadReads, recordingProviders, versionOf, type CaseReads } from "../eval/gold/uk-reads";
import { FAILING, printGate, replayScan, runScan, scoreIxbrl, scoreScan, type GateResult } from "../eval/gold/uk-run";

const BRISTOL = UK_GOLD.find((g) => g.companyNumber === "02662226" && g.scan)!;
const BUSY_BEES = UK_GOLD.find((g) => g.companyNumber === "03454787")!;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

async function offline<T>(fn: () => Promise<T>): Promise<{ value: T; fetched: number }> {
  const real = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    throw new Error("a gate test tried to reach the network");
  }) as typeof fetch;
  try {
    return { value: await fn(), fetched };
  } finally {
    globalThis.fetch = real;
  }
}

let bristol: Awaited<ReturnType<typeof replayScan>> | null = null;
async function bristolRun() {
  if (!bristol) bristol = (await offline(() => replayScan(BRISTOL, loadReads(BRISTOL.folder)!))).value;
  return bristol;
}

suite("ukRun / replay through the real path, offline");

test("Bristol Water replays with no network call, and a stale recording is named, not thrown", async () => {
  const { value, fetched } = await offline(() => replayScan(BRISTOL, loadReads(BRISTOL.folder)!));
  assertEqual(fetched, 0, "nothing left the process");
  const named = /recorded under|request differs|which has no recording/;
  assert(value.stale.every((s) => named.test(s)), `every stale reason is a version, a fingerprint or a missing call: ${value.stale.join("; ")}`);
});

// WP-BE21 (pf2) and the second read's v3/schema 3 came after this recording. Bristol answers again
// only after a live re-record, which needs API credit. Delete this skip after the re-record.
test("Bristol Water replays with every request fingerprint matching (re-recorded on this branch, WP-BE14-LIVE-2)", async () => {
  const { value } = await offline(() => replayScan(BRISTOL, loadReads(BRISTOL.folder)!));
  assertEqual(value.stale.length, 0, `not stale: ${value.stale.join("; ")}`);
  assert(value.log.served.length >= 3, "first read, second read and debt-note read were served");
  assert(value.log.served.every((s) => s.fingerprint === "same" && s.version === "current"), JSON.stringify(value.log.served));
});

test("Bristol Water scores clean: preference shares apart, interest payable rightly abstains", async () => {
  const { run } = await bristolRun();
  const { rows } = scoreScan(BRISTOL, run);
  assertEqual(rows.filter((r) => FAILING.includes(r.verdict)).length, 0, "nothing wrongly surfaced");
  assertEqual(rows.find((r) => r.what === "interest_payable")?.verdict, "abstained-rightly", "the preference dividend is not interest");
  assertEqual(rows.find((r) => r.what === "preference_shares")?.verdict, "right", "preference shares");
});

suite("ukRun / what fails the gate, and what does not");

test("a surfaced value that contradicts the gold is a failure", async () => {
  const { run } = await bristolRun();
  const r = clone(run);
  const fig = r.lines.figures.find((f) => f.key === "cash_at_bank")!;
  fig.tag.evidence!.pounds += 100_000;
  const row = scoreScan(BRISTOL, r).rows.find((x) => x.what === "cash_at_bank")!;
  assertEqual(row.verdict, "wrong-value", "wrong value");
  assert(FAILING.includes(row.verdict), "fails the gate");
});

test("a liability printed with the other sign on another page is the same liability: right, and the sign is named", async () => {
  const { run } = await bristolRun();
  const r = clone(run);
  const fig = r.lines.figures.find((f) => f.key === "preference_shares")!;
  fig.tag.evidence!.pounds = -fig.tag.evidence!.pounds;
  const row = scoreScan(BRISTOL, r).rows.find((x) => x.what === "preference_shares")!;
  assertEqual(row.verdict, "right", "compared by size, as the sheet takes it");
  assert(row.detail.includes("printed sign differs"), row.detail);
});

test("a signed line with the wrong sign still fails: cash is not compared by size", async () => {
  const { run } = await bristolRun();
  const r = clone(run);
  const fig = r.lines.figures.find((f) => f.key === "cash_at_bank")!;
  fig.tag.evidence!.pounds = -fig.tag.evidence!.pounds;
  assertEqual(scoreScan(BRISTOL, r).rows.find((x) => x.what === "cash_at_bank")!.verdict, "wrong-value", "a flipped sign on a signed line");
});

test("a figure surfaced where the gold says abstain is a failure", async () => {
  const { run } = await bristolRun();
  const g: UkGoldCase = clone(BRISTOL);
  g.figures.find((f) => f.metric === "cash_at_bank")!.value = "ABSTAIN";
  assertEqual(scoreScan(g, run).rows.find((x) => x.what === "cash_at_bank")?.verdict, "surfaced-not-there", "surfaced where nothing should be");
});

test("an abstention where the gold has a value is reported, never a failure", async () => {
  const { run } = await bristolRun();
  const r = clone(run);
  r.lines.figures = r.lines.figures.filter((f) => f.key !== "cash_at_bank");
  r.lines.abstentions.push({ key: "cash_at_bank", metric: "cash", label: "Cash", reason: "the two reads disagreed" });
  const row = scoreScan(BRISTOL, r).rows.find((x) => x.what === "cash_at_bank")!;
  assertEqual(row.verdict, "abstained", "abstained");
  assert(!FAILING.includes(row.verdict), "caution does not fail the gate");
});

test("a sheet value that differs from what the double read agreed is a failure", async () => {
  const { run } = await bristolRun();
  const r = clone(run);
  const fact = Object.values(r.manifest.facts).find((f) => f.metric === "cash" && f.value !== null)!;
  fact.value = (fact.value as number) + 1;
  assert(scoreScan(BRISTOL, r).rows.some((x) => x.verdict === "sheet-differs"), "the landing is checked too");
});

test("a facility cell that contradicts the gold facility is a failure", async () => {
  // The gate matches a gold facility to the row whose agreed committed size is the gold amount, else
  // to the first row of the same type. In the re-recorded reads (WP-BE14-LIVE-2) no debenture's
  // committed size is agreed (only the first read copied the nominal, e.g. "£1,405,218"), and the
  // first read lists note 13's "Debentures 1.6" subtotal first, which the second read did not list,
  // so the type match lands on that abstained row. Dropping the subtotal from the recorded first
  // read (one entry) lets the type match reach "£1,405,218 Consolidated debentures", whose drawn
  // 1.4 both reads agreed.
  const reads: CaseReads = clone(loadReads(BRISTOL.folder)!);
  const first = reads.calls.find((c) => c.stage === "first-read")!;
  const block = [...(first.response as any).content].reverse().find((b: any) => b.type === "text");
  const answer = JSON.parse(block.text);
  assertEqual(answer.debt_note.facilities[0].name_as_printed, "Debentures", "the recorded subtotal comes first");
  answer.debt_note.facilities.shift();
  block.text = JSON.stringify(answer);
  const { run } = (await offline(() => replayScan(BRISTOL, reads))).value;
  const g: UkGoldCase = clone(BRISTOL);
  const agreed = scoreScan(g, run).rows.filter((x) => x.what.startsWith("facility"));
  assert(agreed.every((x) => x.verdict !== "wrong-value"), JSON.stringify(agreed.map((x) => [x.what, x.verdict, x.detail])));
  // The drawn cell the two reads agreed now disagrees with the gold.
  const gf = g.facilities![0];
  gf.drawnAtPeriodEnd = 1;
  const rows = scoreScan(g, run).rows.filter((x) => x.what.startsWith("facility"));
  assert(rows.some((x) => x.verdict === "wrong-value"), JSON.stringify(rows.map((x) => [x.what, x.verdict, x.detail])));
});

test("exit codes: 1 on a wrongly surfaced figure, 2 on a stale recording under --strict, 0 otherwise; no pooled rate", () => {
  const quiet = <T>(fn: () => T): { value: T; out: string } => {
    const log = console.log;
    let out = "";
    console.log = (...a: unknown[]) => void (out += a.join(" ") + "\n");
    try {
      return { value: fn(), out };
    } finally {
      console.log = log;
    }
  };
  const empty: GateResult = { rows: [], unscored: [], stale: [], notRun: [], unfingerprinted: [], extra: [] };
  const right = { company: "X", what: "cash_at_bank", status: "tie-checked" as const, gold: "£1", verdict: "right" as const, detail: "" };
  const clean = quiet(() => printGate({ ...empty, rows: [right] }, false));
  assertEqual(clean.value, 0, "clean");
  assert(/NO FIGURE IN THIS SET HAS BEEN CHECKED BY A PERSON/.test(clean.out), "says nobody checked the set");
  assert(!/together|overall|pooled/i.test(clean.out), "never pools the labels into one rate");
  assertEqual(quiet(() => printGate({ ...empty, rows: [{ ...right, verdict: "wrong-value" }] }, false)).value, 1, "wrong value");
  assertEqual(quiet(() => printGate({ ...empty, rows: [right], stale: [{ g: BRISTOL, why: ["old"] }] }, false, true)).value, 2, "stale, strict");
  assertEqual(quiet(() => printGate({ ...empty, rows: [right], stale: [{ g: BRISTOL, why: ["old"] }] }, false)).value, 0, "stale, offline default: listed, not failed");
  assertEqual(quiet(() => printGate({ ...empty, rows: [{ ...right, verdict: "wrong-value" }], stale: [{ g: BRISTOL, why: ["old"] }] }, false)).value, 1, "a wrong value fails even with stale filings");
  assertEqual(quiet(() => printGate({ ...empty, rows: [{ ...right, verdict: "abstained" }] }, false)).value, 0, "an abstention passes");
});

suite("ukRun / stale recordings are caught, not scored");

test("a recording under an older prompt or schema version is stale", async () => {
  const reads: CaseReads = clone(loadReads(BRISTOL.folder)!);
  reads.calls.find((c) => c.stage === "second-read")!.version = "v1/schema 1";
  const { stale } = (await offline(() => replayScan(BRISTOL, reads))).value;
  assert(stale.some((s) => /recorded under v1\/schema 1; the code now runs/.test(s)), stale.join("; "));
  assertEqual(versionOf("second-read").startsWith("v"), true, "the current version is read from the code");
});

test("a request that differs from the one recorded is stale", async () => {
  const reads: CaseReads = clone(loadReads(BRISTOL.folder)!);
  reads.calls.find((c) => c.stage === "first-read")!.requestSha256 = "0".repeat(64);
  const { stale } = (await offline(() => replayScan(BRISTOL, reads))).value;
  assert(stale.some((s) => /"first-read" request differs/.test(s)), stale.join("; "));
});

test("a call the current code makes with no recording is stale", async () => {
  const reads: CaseReads = clone(loadReads(BRISTOL.folder)!);
  reads.calls = reads.calls.filter((c) => c.stage !== "facility-read");
  const { stale } = (await offline(() => replayScan(BRISTOL, reads))).value;
  assert(stale.some((s) => /calls "facility-read", which has no recording/.test(s)), stale.join("; "));
});

suite("ukRun / eval:uk:live spends nothing it should not");

test("the recorder refuses a call once the cap is reached, before reaching the network", async () => {
  const rec = recordingProviders({ apiKey: "k", readerModel: "claude-opus-5", finderModel: "claude-haiku-4-5", capGbp: 2, alreadySpentGbp: () => 2 });
  const { fetched } = await offline(async () => {
    const fetchImpl = (rec.reader as unknown as { fetchImpl: typeof fetch }).fetchImpl;
    return fetchImpl("https://api.anthropic.com/v1/messages", { body: JSON.stringify({ model: "claude-opus-5", system: "x", messages: [] }) }).catch((e: Error) => e);
  });
  assertEqual(fetched, 0, "no call was made");
  assertEqual(rec.calls.length, 0, "nothing recorded");
});

test("recorded calls kept for reuse are served without a call and without spend", async () => {
  const reads = loadReads(BRISTOL.folder)!;
  // A cap of 0: any call not served from reuse would be refused, and the run would lose its figures.
  const rec = recordingProviders({ apiKey: "k", readerModel: "claude-opus-5", finderModel: "claude-haiku-4-5", capGbp: 0, alreadySpentGbp: () => 0, reuse: reads.calls });
  const { value, fetched } = await offline(() => runScan(BRISTOL, rec.reader, rec.finder));
  assertEqual(fetched, 0, "offline");
  assertEqual(rec.spentGbp(), 0, "reuse costs nothing");
  assertEqual(rec.calls.length, reads.calls.length, "every stage was served from reuse");
  assert(value.lines.figures.length > 0, "and the run still reads the filing");
});

suite("ukRun / iXBRL through the live mapper");

test("Busy Bees: borrowings, net debt, EBITDA and leverage agree with the gold's printed inputs", () => {
  const { rows } = scoreIxbrl(BUSY_BEES);
  for (const what of ["borrowings_total", "net_debt (borrowings less cash)", "ebitda (operating profit + tagged D&A)", "leverage"]) {
    assertEqual(rows.find((r) => r.what === what)?.verdict, "right", what);
  }
  assertEqual(rows.filter((r) => FAILING.includes(r.verdict)).length, 0, "nothing wrongly surfaced");
});
