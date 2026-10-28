// scripts/refresh-vision-fixtures.ts
// Copies the model answers recorded by `npm run eval:uk:live -- --spend` into the unit-test copies
// under test/fixtures/vision/, so the unit tests replay what the gate replays.
//
//   npx tsx scripts/refresh-vision-fixtures.ts           say what would change
//   npx tsx scripts/refresh-vision-fixtures.ts --write   change it
//
// The gate's recordings (eval/gold/fixtures/uk/<folder>/reads.json) are the source of truth. Until
// WP-BE14-LIVE-2 this copy was done by hand after every re-record (WP-BE23-rebased, step 6). Each
// test fixture keeps its own shape and notes; only the recorded responses and the versions they
// were recorded under change. A stage the recording does not hold is left as it was and named.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadReads, versionOf, replayProviders, UK_FIXTURES, type CaseReads, type RecordedCall, type ReplayLog } from "../eval/gold/uk-reads";
import { readScannedAccounts, type PagedVisionReadResult } from "../lib/vision/client";
import { InMemoryCache } from "../lib/cache/cache";
import { UK_GOLD } from "../eval/gold/uk";
import { BASE_LINE_KEYS, type FoundLine } from "../lib/vision/types";

const ROOT = resolve(__dirname, "..");
const VISION = join(ROOT, "test", "fixtures", "vision");
const write = process.argv.includes("--write");

type Json = Record<string, unknown>;

function readsFor(companyNumber: string): { folder: string; reads: CaseReads } | null {
  const g = UK_GOLD.find((c) => c.companyNumber === companyNumber && c.scan);
  if (!g) return null;
  const reads = loadReads(g.folder);
  return reads ? { folder: g.folder, reads } : null;
}

// "p3/schema 3" -> { promptVersion: "p3", schemaVersion: 3 }
function versions(v: string | null): { promptVersion?: string; schemaVersion?: number } {
  const m = v ? /^(\S+)\/schema (\d+)$/.exec(v) : null;
  return m ? { promptVersion: m[1], schemaVersion: Number(m[2]) } : {};
}

// Recorded calls of one stage in order. Stages that run more than once (classify batches) are keyed
// by their page range, so a same-named stage is matched to the same-named recording.
function callsOf(reads: CaseReads, stage: string): RecordedCall[] {
  return reads.calls.filter((c) => c.stage === stage);
}

const changes: string[] = [];
const left: string[] = [];

async function refresh(rel: string): Promise<void> {
  const path = join(VISION, rel);
  const fx = JSON.parse(readFileSync(path, "utf8")) as Json;
  const companyNumber = String(fx.companyNumber ?? "");
  const src = readsFor(companyNumber);
  if (!src) {
    left.push(`${rel}: no gold recording for ${companyNumber}`);
    return;
  }
  let touched = false;

  // Single-response fixtures: the first read (top level, or kind "first-read") and the second read.
  if ("response" in fx) {
    const stage = fx.kind === "second-read" ? "second-read" : "first-read";
    const call = callsOf(src.reads, stage)[0];
    if (!call) {
      left.push(`${rel}: ${stage} not in ${src.folder}/reads.json`);
    } else {
      fx.response = call.response;
      Object.assign(fx, versions(call.version ?? versionOf(stage)));
      fx.recordedAt = call.recordedAt;
      touched = true;
    }
  }

  // Multi-call fixtures (page finding, facilities): each call replaced by the recording's call of
  // the same stage. A stage the recording lacks is kept and named.
  if (Array.isArray(fx.calls)) {
    const used = new Map<string, number>();
    const calls = fx.calls as Json[];
    const next: Json[] = [];
    for (const c of calls) {
      const stage = String(c.stage);
      const n = used.get(stage) ?? 0;
      used.set(stage, n + 1);
      const rec = callsOf(src.reads, stage)[n];
      if (!rec) {
        left.push(`${rel}: ${stage} not in ${src.folder}/reads.json; kept`);
        next.push(c);
        continue;
      }
      next.push({ ...c, model: rec.model, response: rec.response, status: 200 });
      touched = true;
    }
    // A stage the new recording made that the old fixture never held (a new classify batch after a
    // page-finder change) is added, so the replay is not short of an answer.
    const isFinderFixture = calls.some((c) => c.stage === "contents" || String(c.stage).startsWith("classify:"));
    for (const rec of src.reads.calls) {
      const had = calls.some((c) => c.stage === rec.stage);
      const finderStage = rec.stage === "contents" || rec.stage.startsWith("classify:");
      if (!had && isFinderFixture && finderStage) {
        next.push({ stage: rec.stage, model: rec.model, response: rec.response, status: 200 });
        touched = true;
      }
    }
    // Keep the recording's order, which is the order the engine makes the calls in.
    const order = (s: string) => src.reads.calls.findIndex((r) => r.stage === s);
    next.sort((a, b) => order(String(a.stage)) - order(String(b.stage)));
    fx.calls = next;
    if (touched) fx.recordedAt = src.reads.calls.map((c) => c.recordedAt).sort().slice(-1)[0];
  }

  // A page-finding fixture says which pages the first read was sent, and a second-read fixture which
  // pages the second read was sent (the pages the first read cited). The gold recording keeps only a
  // fingerprint of each request, so the pages are found by replaying it offline. The replay's
  // first-read request must have the recorded fingerprint: then it is, byte for byte, the request
  // that was recorded, and the pages it sent and cited are the recorded ones.
  const isPages = rel.startsWith("pages/");
  const isSecond = fx.kind === "second-read";
  if (touched && Array.isArray(fx.pagesSent) && (isPages || isSecond)) {
    const g = UK_GOLD.find((c) => c.companyNumber === companyNumber && c.scan)!;
    const log: ReplayLog = { served: [], missing: [] };
    const { reader, finder } = replayProviders(src.reads, log);
    const pageFound = src.reads.calls.some((c) => c.stage === "contents");
    const read = (await readScannedAccounts(
      { pdfBytes: new Uint8Array(readFileSync(join(UK_FIXTURES, src.folder, "filing.pdf"))), transactionId: g.transactionId, companyNumber, pageCount: g.pageCount },
      pageFound ? { provider: reader, pageFinder: finder, cache: new InMemoryCache() } : { provider: reader, cache: new InMemoryCache(), pageFindingAbovePages: 200 }
    )) as PagedVisionReadResult;
    const first = log.served.find((s) => s.stage === "first-read");
    if (first?.fingerprint !== "same") {
      left.push(`${rel}: the replayed first read is not the recorded request (${first?.fingerprint ?? "not served"}); pagesSent kept`);
    } else if (isPages && read.pageFinding) {
      fx.pagesSent = read.pageFinding.pages;
      fx.gbp = Number(src.reads.calls.filter((c) => c.stage !== "facility-read").reduce((t, c) => t + (c.gbp ?? 0), 0).toFixed(4));
      fx.pagesNote = "pagesSent and gbp are from the gold recording (WP-BE14-LIVE-2). seconds and usage are from the WP-BE18 recording: the gold recording does not time its calls.";
    } else if (isSecond && read.outcome === "read") {
      const cited = BASE_LINE_KEYS.map((k) => read.lines[k]).filter((l) => l.status === "found").map((l) => (l as FoundLine).pdfPageIndex);
      fx.pagesSent = [...new Set(cited)].sort((a, b) => a - b);
    } else {
      left.push(`${rel}: the replay gave no ${isPages ? "page-finding" : "read"}; pagesSent kept`);
    }
  }

  if (touched) {
    changes.push(`${rel} <- ${src.folder}/reads.json`);
    if (write) writeFileSync(path, JSON.stringify(fx, null, rel.startsWith("pages/") || rel.startsWith("facilities/") ? 1 : 2) + "\n");
  }
}

const files = [
  ...readdirSync(VISION).filter((f) => f.endsWith(".json")),
  ...["verify", "pages", "facilities"].flatMap((d) =>
    existsSync(join(VISION, d)) ? readdirSync(join(VISION, d)).filter((f) => f.endsWith(".json")).map((f) => `${d}/${f}`) : [],
  ),
].filter((f) => !f.endsWith("-finder.json")); // the page-finder truth set is its own recording, not a gold scan

async function main(): Promise<void> {
  for (const f of files) await refresh(f);
  console.log(`${write ? "Refreshed" : "Would refresh"} ${changes.length} fixture(s):`);
  for (const c of changes) console.log(`  ${c}`);
  if (left.length) {
    console.log("Left as they were:");
    for (const l of left) console.log(`  ${l}`);
  }
  if (!write) console.log("\nNothing was written. Add --write.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
