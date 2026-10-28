// lib/vision/client.ts
// Read a scanned Companies House accounts PDF with a vision model, as structured output.
//
// A filing of up to 60 pages goes whole as a base64 document block. A longer one, or one over the
// model's PDF limits, is page-found first (lib/vision/pages.ts, WP-BE15): a cheap model finds the
// primary statements and the debt notes, pdf-lib cuts those pages into a new PDF, and only that
// goes to the reader. Every page index in the result is mapped back to the ORIGINAL filing, so a
// citation names the page a person would open and the verifier cuts the same pages from the
// original bytes. If page-finding fails, every line abstains with its reason and the whole
// document is never sent. A filing is never truncated.
//
// A successful read is cached under a versioned key (the page set is part of it), and so is a
// successful page-finding, so a repeat makes no model call. Failures are not cached, so a later
// run can try again.

import { getCache, type Cache } from "../cache/cache";
import { getAnthropicProvider, getLLMConfig } from "../llm/config";
import type { LLMEffort, LLMFailureKind, StructuredLLMProvider } from "../llm/types";
import { VISION_SCHEMA, VISION_SCHEMA_VERSION, abstainAll, normaliseVisionOutput, parseVisionOutput, type NormalisedRead } from "./schema";
import { PROMPT_VERSION, VISION_PROMPT_FINGERPRINT_TEXT, VISION_SYSTEM_PROMPT, visionUserText } from "./prompt";
import { VISION_CACHE_TTL_SECONDS, cacheModelFor, getCachedRead, pageSetLabel, promptSchemaHash, setCachedRead, visionCacheKey } from "./cache";
import { ABSTAIN, type VisionOutcome, type VisionReadInput, type VisionReadResult } from "./types";
import type { LLMUsage } from "../llm/types";
import {
  PAGE_FINDER_MODEL_DEFAULT,
  PAGE_FINDING_ABOVE_PAGES,
  PAGE_FINDING_ABSTAIN,
  PAGE_FINDING_COST_CAP_GBP,
  cutPages,
  findPages,
  openPdf,
  pageFindingCacheKey,
  pdfPageCount,
  spentGbp,
  sumUsage,
  toOriginalPage,
  type PageFinding,
} from "./pages";

// PDF input limits (claude-api skill, Document input): a 32 MB request and 600 pages, or 100
// pages on models with a 200k context window.
export const PDF_MAX_REQUEST_BYTES = 32 * 1024 * 1024;
export const PDF_MAX_PAGES = 600;
export const PDF_MAX_PAGES_200K_CONTEXT = 100;
const MODELS_WITH_200K_CONTEXT = ["claude-haiku-4-5"];
// Room for the system prompt, schema and JSON framing inside the request limit.
const REQUEST_OVERHEAD_BYTES = 256 * 1024;

export const VISION_MAX_TOKENS = 32_000;

export function pdfPageLimitFor(model: string | null): number {
  return model && MODELS_WITH_200K_CONTEXT.some((m) => model.startsWith(m)) ? PDF_MAX_PAGES_200K_CONTEXT : PDF_MAX_PAGES;
}

// Base64 grows the bytes by 4/3. Null means the filing fits; otherwise a short reason.
//
// An unknown page count is a breach, not a pass. countPdfPages returns 0 when it cannot tell,
// and 0 used to sail through both this limit and the page-finding threshold, so a filing nobody
// could measure was sent whole. A count we do not have is the case the limit exists for.
export function pdfLimitBreach(byteLength: number, pageCount: number, model: string | null): string | null {
  const maxPages = pdfPageLimitFor(model);
  if (!Number.isInteger(pageCount) || pageCount < 1) return "page count unknown, so the filing was not sent";
  if (pageCount > maxPages) return `${pageCount} pages over the ${maxPages}-page limit`;
  const requestBytes = 4 * Math.ceil(byteLength / 3) + REQUEST_OVERHEAD_BYTES;
  if (requestBytes > PDF_MAX_REQUEST_BYTES) return `request of ${requestBytes} bytes over the ${PDF_MAX_REQUEST_BYTES}-byte limit`;
  return null;
}

// Count pages from the PDF itself when metadata gave no usable count. 0 means "cannot tell",
// which every caller must treat as a breach rather than as a small filing.
//
// pdf-lib is the reader, through the same openPdf that page finding cuts with, because it parses
// the page tree properly and recovers from the broken cross-reference tables the Companies House
// scans carry. There used to be a "/Type /Page" regex fallback for a file pdf-lib refused. It was
// wrong on any PDF that keeps its page objects in an object stream (a re-saved gold fixture read
// 26 pages through pdf-lib and 0 through the regex), and a file pdf-lib cannot open cannot be cut
// either, so a count from anything else only let an unreadable file be sent whole (RS-06).
export async function countPdfPages(bytes: Uint8Array): Promise<number> {
  return (await pdfPageCount(bytes)) ?? 0;
}

export interface VisionDeps {
  provider?: StructuredLLMProvider | null; // default: the env-configured Anthropic provider
  cache?: Cache; // default: getCache()
  maxTokens?: number;
  schemaVersion?: number; // test seams for "a version change misses"
  promptVersion?: string;
  // Serve a cached read or abstain; never make a model call. This is what a universe screen
  // runs on (audit BE-18), so a sweep of fifty members cannot spend anything.
  cacheOnly?: boolean;
  // The cheap model that finds pages in a large filing. Left out, it is built from the
  // environment (PAGE_FINDER_MODEL, default claude-haiku-4-5, on the same key) only when the
  // reader is too; a caller that injects a reader and no finder gets no finder, so a test with a
  // mock reader can never make a live page-finding call. Null means no finder.
  pageFinder?: StructuredLLMProvider | null;
  // Filings longer than this are page-found. Default PAGE_FINDING_ABOVE_PAGES (60). The WP-BE05
  // recordings of whole 69 to 113-page reads replay with this raised.
  pageFindingAbovePages?: number;
  costCapGbp?: number; // page-finding plus the first read; default PAGE_FINDING_COST_CAP_GBP
}

// The page-finding summary a page-found read carries, for the report, the evidence card and the
// spend log. `pages` are original page indexes.
export interface PageFindingSummary {
  finderModel: string;
  pages: number[];
  byRole: PageFinding["byRole"];
  missing: PageFinding["missing"];
  range: PageFinding["range"] | null; // null when page-finding failed before it classified anything
  contentsPage: number | null;
  calls: number;
  usage: LLMUsage | null; // the page-finding calls alone; the result's usage includes them
  fromCache: boolean;
  failure?: { reason: string; detail: string };
}

export type PagedVisionReadResult = VisionReadResult & { pageFinding?: PageFindingSummary };

export function defaultPageFinder(): StructuredLLMProvider | null {
  const config = getLLMConfig();
  const model = (process.env.PAGE_FINDER_MODEL ?? "").trim() || PAGE_FINDER_MODEL_DEFAULT;
  return getAnthropicProvider({ ...config, model });
}

// The text that tells the reader it has an excerpt. It goes after the usual user text, so the
// first read's rules and definitions are the same words for a whole filing and a subset.
export function excerptUserText(companyNumber: string, subsetPages: number, filingPages: number): string {
  return `${visionUserText(companyNumber)} This PDF is an excerpt: ${subsetPages} pages cut from the filed accounts, which run to ${filingPages} pages, holding the primary statements and the debt notes. Give pdf_page_index as the position of the page in this excerpt, where its first page is 1.`;
}
// The first read of a page-found subset thinks at "medium", not Opus 5's default "high" (WP-BE18).
// WP-BE15's live run on 22 Sep 2026 spent about 1,650 of the first read's 3,900 output tokens
// thinking, and the output tokens, not the pages, set the time: 40 s of James Fisher's 98.7 s. The
// read is a transcription checked by a second, independent read and by the printed ties, so less
// thinking can make a figure abstain but cannot make one appear. The effort is in the cache key.
export const PAGE_FOUND_READ_EFFORT: LLMEffort = "medium";

const EXCERPT_FINGERPRINT_TEXT = `${VISION_PROMPT_FINGERPRINT_TEXT}\n---\n${excerptUserText("{companyNumber}", 0, 0)}\n---\neffort:${PAGE_FOUND_READ_EFFORT}`;

const FAILURE_REASON: Record<LLMFailureKind, string> = {
  unconfigured: ABSTAIN.unconfigured,
  refusal: "model-refusal",
  max_tokens: "model-max-tokens",
  timeout: "model-timeout",
  retries_exhausted: "model-unavailable",
  http: "model-http-error",
  network: "model-network-error",
  bad_response: "model-bad-response",
  unsupported_content: "model-unsupported-content",
};

export async function readScannedAccounts(input: VisionReadInput, deps: VisionDeps = {}): Promise<VisionReadResult> {
  const provider = deps.provider !== undefined ? deps.provider : getAnthropicProvider();
  const cache = deps.cache ?? getCache();
  const model = provider?.model ?? null;
  const schemaVersion = deps.schemaVersion ?? VISION_SCHEMA_VERSION;
  const promptVersion = deps.promptVersion ?? PROMPT_VERSION;
  const pageCount = Number.isInteger(input.pageCount) && input.pageCount > 0 ? input.pageCount : await countPdfPages(input.pdfBytes);
  // With no provider this is the model LLM_MODEL names, so a read already paid for is served.
  const cacheModel = cacheModelFor(provider);
  const cacheKey = visionCacheKey({
    model: cacheModel,
    transactionId: input.transactionId,
    pageSet: "all",
    schemaVersion,
    promptVersion,
    hash: promptSchemaHash(),
  });

  const build = (
    outcome: VisionOutcome,
    read: NormalisedRead,
    usage: LLMUsage | null,
    failure?: { kind: string; detail: string }
  ): VisionReadResult => ({
    outcome,
    fromCache: false,
    cacheKey,
    schemaVersion,
    promptVersion,
    model,
    transactionId: input.transactionId,
    companyNumber: input.companyNumber,
    pageSet: "all",
    ...read,
    usage,
    recordedUsage: usage,
    ...(failure ? { failure } : {}),
  });

  // Too large: no truncation, no call.
  const breach = pdfLimitBreach(input.pdfBytes.byteLength, pageCount, model);
  if (breach || pageCount > (deps.pageFindingAbovePages ?? PAGE_FINDING_ABOVE_PAGES)) {
    return readPageFound(input, deps, { provider, cache, model, schemaVersion, promptVersion, pageCount, breach });
  }

  // The cache first, model or no model: a read already paid for is served with no call (WP-BE14).
  const hit = await getCachedRead(cacheKey, cache);
  if (hit) return { ...hit, fromCache: true, usage: null };

  if (!provider) {
    return build("unconfigured", abstainAll(ABSTAIN.unconfigured), null, { kind: "unconfigured", detail: "no Anthropic provider configured" });
  }

  // Cache-only: a miss abstains rather than paying. The caller asked to read what is already
  // held, not to buy a read.
  if (deps.cacheOnly) {
    return build("cache-miss", abstainAll(ABSTAIN.cacheOnly), null, {
      kind: "cache-only",
      detail: "no cached read for this filing, and this caller may not make a model call",
    });
  }

  const result = await provider.send({
    system: VISION_SYSTEM_PROMPT,
    content: [
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: Buffer.from(input.pdfBytes).toString("base64") },
      },
      { type: "text", text: visionUserText(input.companyNumber) },
    ],
    maxTokens: deps.maxTokens ?? VISION_MAX_TOKENS,
    outputSchema: VISION_SCHEMA,
    label: `vision:${input.companyNumber}`,
  });

  if (!result.ok) {
    const reason = FAILURE_REASON[result.failure.kind];
    const outcome: VisionOutcome = result.failure.kind === "unconfigured" ? "unconfigured" : "model-failure";
    return build(outcome, abstainAll(reason), result.usage, { kind: result.failure.kind, detail: result.failure.detail });
  }

  const parsed = parseVisionOutput(result.text);
  if (!parsed.ok) {
    return build("malformed", abstainAll(ABSTAIN.malformed), result.usage, {
      kind: "malformed",
      detail: parsed.errors.slice(0, 5).join("; "),
    });
  }

  const read = build("read", normaliseVisionOutput(parsed.value, pageCount), result.usage);
  await setCachedRead(cacheKey, read, cache);
  return read;
}

// ---------------------------------------------------------------------------
// Large filings: page-find, cut, read the subset (WP-BE15)
// ---------------------------------------------------------------------------

interface PageFoundContext {
  provider: StructuredLLMProvider | null;
  cache: Cache;
  model: string | null;
  schemaVersion: number;
  promptVersion: string;
  pageCount: number;
  breach: string | null;
}

// Map every page index in a read of a subset back to the original filing. A line the reader
// abstained on as not printed was not printed on the pages it was sent, which is not the same as
// not printed in the filing (WP-BE21: on Kemble Water the sheet said "not printed" of a balance
// sheet one page away). The reason names the pages read.
export function scopeToPagesRead(reason: string, subsetPages: number[], pageCount: number): string {
  if (!reason.startsWith("not-printed")) return reason;
  return `${reason} on the ${subsetPages.length} pages read (PDF pages ${subsetPages.join(", ")} of ${pageCount}), which page-finding chose`;
}

function toOriginal(read: NormalisedRead, subsetPages: number[], pageCount: number): NormalisedRead {
  const lines = Object.fromEntries(
    Object.entries(read.lines).map(([k, l]) => [
      k,
      l.status === "found"
        ? { ...l, pdfPageIndex: toOriginalPage(subsetPages, l.pdfPageIndex) }
        : { ...l, reason: scopeToPagesRead(l.reason, subsetPages, pageCount) },
    ])
  ) as NormalisedRead["lines"];
  const orNull = (p: number | null) => (p === null ? null : toOriginalPage(subsetPages, p) || null);
  const debtNote: NormalisedRead["debtNote"] =
    read.debtNote.status === "found"
      ? {
          ...read.debtNote,
          pdfPageIndexes: read.debtNote.pdfPageIndexes.map((p) => toOriginalPage(subsetPages, p)).filter((p) => p > 0),
          facilities: read.debtNote.facilities.map((f) => ({ ...f, pdfPageIndex: orNull(f.pdfPageIndex) })),
          maturityBuckets: read.debtNote.maturityBuckets.map((b) => ({ ...b, pdfPageIndex: orNull(b.pdfPageIndex) })),
        }
      : read.debtNote;
  return { ...read, lines, debtNote };
}

async function readPageFound(input: VisionReadInput, deps: VisionDeps, ctx: PageFoundContext): Promise<PagedVisionReadResult> {
  const { provider, cache, model, schemaVersion, promptVersion, pageCount } = ctx;
  const excerptHash = promptSchemaHash(EXCERPT_FINGERPRINT_TEXT);
  const finder = deps.pageFinder !== undefined ? deps.pageFinder : deps.provider !== undefined ? null : defaultPageFinder();
  const finderModel = finder?.model ?? ((process.env.PAGE_FINDER_MODEL ?? "").trim() || PAGE_FINDER_MODEL_DEFAULT);
  const why = ctx.breach ? `${ctx.breach}, so it is page-found` : `${pageCount} pages, over the ${deps.pageFindingAbovePages ?? PAGE_FINDING_ABOVE_PAGES}-page whole-read limit, so it is page-found`;

  const build = (
    outcome: VisionOutcome,
    read: NormalisedRead,
    pageSet: number[] | "all",
    usage: LLMUsage | null,
    pageFinding: PageFindingSummary | undefined,
    failure?: { kind: string; detail: string }
  ): PagedVisionReadResult => ({
    outcome,
    fromCache: false,
    cacheKey:
      pageSet === "all"
        ? ""
        : visionCacheKey({ model: model ?? "none", transactionId: input.transactionId, pageSet, schemaVersion, promptVersion, hash: excerptHash }),
    schemaVersion,
    promptVersion,
    model,
    transactionId: input.transactionId,
    companyNumber: input.companyNumber,
    pageSet: pageSet === "all" ? "all" : pageSetLabel(pageSet),
    ...read,
    usage,
    recordedUsage: usage,
    ...(failure ? { failure } : {}),
    ...(pageFinding ? { pageFinding } : {}),
  });
  // Page-finding failed or could not run: every line abstains with the reason, nothing is sent.
  const abstain = (reason: string, detail: string, usage: LLMUsage | null, calls: number, outcome: VisionOutcome = "too-large") =>
    build(
      outcome,
      abstainAll(reason),
      "all",
      usage,
      { finderModel, pages: [], byRole: {}, missing: [], range: null, contentsPage: null, calls, usage, fromCache: false, failure: { reason, detail } },
      { kind: "page-finding", detail: `${why}; ${detail}; the whole document was not sent` }
    );

  // A cached page-finding and a cached read of its subset make no call at all, and are served
  // with no model configured too (WP-BE14): before, this path gave up first and never looked.
  const findingKey = pageFindingCacheKey(finderModel, input.transactionId);
  let finding = await cache.get<PageFinding>(findingKey);
  const findingFromCache = finding !== null;
  if (finding) {
    const readKey = visionCacheKey({ model: cacheModelFor(provider), transactionId: input.transactionId, pageSet: finding.pages, schemaVersion, promptVersion, hash: excerptHash });
    const hit = await getCachedRead(readKey, cache);
    if (hit) return { ...hit, fromCache: true, usage: null };
  }
  if (!provider) {
    return build("unconfigured", abstainAll(ABSTAIN.unconfigured), "all", null, undefined, { kind: "unconfigured", detail: "no Anthropic provider configured" });
  }
  if (deps.cacheOnly) {
    return build("cache-miss", abstainAll(ABSTAIN.cacheOnly), "all", null, undefined, {
      kind: "cache-only",
      detail: "no cached read for this filing, and this caller may not make a model call",
    });
  }

  // Open the filing once; every cut comes from this document.
  const doc = await openPdf(input.pdfBytes);
  if (!doc) return abstain(PAGE_FINDING_ABSTAIN.unopenable, "the PDF could not be opened for cutting", null, 0);
  const cap = deps.costCapGbp ?? PAGE_FINDING_COST_CAP_GBP;

  if (!finding) {
    if (!finder) return abstain(PAGE_FINDING_ABSTAIN.unconfigured, "no page-finding model is configured", null, 0);
    const found = await findPages(
      { doc, transactionId: input.transactionId, companyNumber: input.companyNumber, readerModel: model ?? "none", costCapGbp: cap },
      { finder }
    );
    if (!found.ok) return abstain(found.reason, found.detail, found.usage, found.calls);
    finding = found.finding;
    await cache.set(findingKey, finding, VISION_CACHE_TTL_SECONDS);
  }
  const findingUsage = findingFromCache ? null : finding.usage;
  const summary: PageFindingSummary = {
    finderModel: finding.finderModel,
    pages: finding.pages,
    byRole: finding.byRole,
    missing: finding.missing,
    range: finding.range,
    contentsPage: finding.contents.contentsPage,
    calls: findingFromCache ? 0 : finding.calls,
    usage: findingUsage,
    fromCache: findingFromCache,
  };

  const subset = await cutPages(doc, finding.pages);
  if (!subset) return abstain(PAGE_FINDING_ABSTAIN.unopenable, `pages ${finding.pages.join(", ")} could not be cut out of this PDF`, findingUsage, summary.calls);
  // The subset must itself fit the limits; SUBSET_MAX_PAGES keeps it far inside them.
  const subsetBreach = pdfLimitBreach(subset.bytes.byteLength, subset.pages.length, model);
  if (subsetBreach) return abstain(PAGE_FINDING_ABSTAIN.overCap, `the subset is still too large: ${subsetBreach}`, findingUsage, summary.calls);
  const spent = spentGbp([findingUsage]);
  if (spent === null || spent > cap) {
    return abstain(PAGE_FINDING_ABSTAIN.overCap, `page-finding spent ${spent === null ? "an unpriced amount" : `GBP ${spent.toFixed(2)}`}, over the GBP ${cap.toFixed(2)} cap`, findingUsage, summary.calls);
  }

  const result = await provider.send({
    system: VISION_SYSTEM_PROMPT,
    content: [
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: Buffer.from(subset.bytes).toString("base64") },
      },
      { type: "text", text: excerptUserText(input.companyNumber, subset.pages.length, pageCount) },
    ],
    maxTokens: deps.maxTokens ?? VISION_MAX_TOKENS,
    outputSchema: VISION_SCHEMA,
    effort: PAGE_FOUND_READ_EFFORT,
    label: `vision:${input.companyNumber}:p${subset.pages.join(",")}`,
  });
  const usage = sumUsage([result.usage, findingUsage], `vision:${input.companyNumber}`);

  if (!result.ok) {
    const reason = FAILURE_REASON[result.failure.kind];
    const outcome: VisionOutcome = result.failure.kind === "unconfigured" ? "unconfigured" : "model-failure";
    return build(outcome, abstainAll(reason), subset.pages, usage, summary, { kind: result.failure.kind, detail: result.failure.detail });
  }
  const parsed = parseVisionOutput(result.text);
  if (!parsed.ok) {
    return build("malformed", abstainAll(ABSTAIN.malformed), subset.pages, usage, summary, {
      kind: "malformed",
      detail: parsed.errors.slice(0, 5).join("; "),
    });
  }
  // Validate page indexes against the subset, then map them to the original filing.
  const read = build("read", toOriginal(normaliseVisionOutput(parsed.value, subset.pages.length), subset.pages, pageCount), subset.pages, usage, summary);
  await setCachedRead(read.cacheKey, read, cache);
  return read;
}
