// eval/gold/uk/freeze.ts
// Freezes the UK gold filings. Each filing is re-fetched from Companies House by company
// number and transaction id (never "latest", so a later filing cannot change the set), and
// written to eval/gold/fixtures/uk/<company number>-<made-up date>/ with a meta.json. The
// Tesco ESEF case is fetched from filings.xbrl.org by LEI and fxo id instead.
//
// Run from product/ (needs CH_API_KEY in .env.local):
//   npx tsx --env-file=.env.local eval/gold/uk/freeze.ts              every filing
//   npx tsx --env-file=.env.local eval/gold/uk/freeze.ts 02662226     one company
//   npx tsx --env-file=.env.local eval/gold/uk/freeze.ts --check      re-fetch, compare sha256, write nothing
//
// Size rule: a document is committed only if it is 15 MB or less, and only while the whole
// fixtures/uk folder stays at 90 MB or less. Otherwise meta.json alone is written with
// bytesCommitted: false, and this script fetches the document again on demand.
//
// meta.json holds public URLs only. The API key is sent as a header and never written.

import { createHash } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { fetchChDocument } from "../../../lib/sources/fetchDoc";
import { pdfToText } from "../../../lib/sources/pdfAccounts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "..", "fixtures", "uk");
const CH_BASE = "https://api.company-information.service.gov.uk";
const FXO_BASE = "https://filings.xbrl.org";
const MB = 1024 * 1024;
const FILE_LIMIT = 15 * MB;
const FOLDER_LIMIT = 90 * MB;
const GAP_MS = 600; // at most two CH requests a second, shared with other runs

export type CaseKind = "scan-full" | "scan-group" | "large-group" | "subsidiary" | "ixbrl" | "esef";

export interface FilingSpec {
  companyNumber: string;
  name: string;
  kind: CaseKind;
  format: "pdf" | "xhtml" | "esef";
  transactionId?: string; // CH filings
  parentTransactionId?: string; // PARENT_ACC filed with an audit-exempt subsidiary's accounts
  lei?: string; // ESEF
  fxoId?: string; // ESEF: the filings.xbrl.org filing, fixed once found
  folderSuffix?: string; // keeps two cases for one company and date apart
  notes: string;
}

// The frozen set. Chosen on Tue 15 Sep 2026 from CH metadata (latest AA or AAMD with a
// document, AA01 skipped). See README.md for why each one is here.
export const FILINGS: FilingSpec[] = [
  {
    companyNumber: "02662226", name: "BRISTOL WATER PLC", kind: "scan-full", format: "pdf",
    transactionId: "MzU0MjkxMjg1OGFkaXF6a2N4",
    notes: "28-page scan. Carries 8.75% irredeemable preference shares, which must be classified outside borrowings (audit finding 19).",
  },
  {
    companyNumber: "11391321", name: "PRET A MANGER LIMITED", kind: "subsidiary", format: "pdf",
    transactionId: "MzUyNzQ5NTk5NmFkaXF6a2N4", parentTransactionId: "MzUyNzQ5NTk3MWFkaXF6a2N4",
    notes: "Audit-exempt subsidiary (s479A). The parent's group accounts were filed the same day as PARENT_ACC and are frozen beside it as parent.pdf.",
  },
  {
    companyNumber: "03558065", name: "BOPARAN HOLDINGS LIMITED", kind: "scan-group", format: "pdf",
    transactionId: "MzUxODk5OTExM2FkaXF6a2N4",
    notes: "Group accounts scan, 113 pages.",
  },
  {
    companyNumber: "03213782", name: "TOPPS TILES PLC", kind: "large-group", format: "pdf",
    transactionId: "MzUwNzM2NzQwNGFkaXF6a2N4",
    notes: "Group accounts scan over 200 pages. IFRS 16 lease case.",
  },
  {
    companyNumber: "00211475", name: "JAMES FISHER AND SONS PUBLIC LIMITED COMPANY", kind: "large-group", format: "pdf",
    transactionId: "MzUyMzIyMjQwNmFkaXF6a2N4",
    notes: "Group accounts scan over 200 pages.",
  },
  {
    companyNumber: "00445790", name: "TESCO PLC", kind: "esef", format: "esef",
    lei: "2138002P5RNKC5W2JZ46", folderSuffix: "esef",
    notes: "ESEF (UKSEF) consolidated statements from filings.xbrl.org. Figures are tag-derived through lib/sources/esef.ts. The xBRL period end is 2026-03-01T00:00:00, the start of the day after the 28 Feb 2026 year end, so the folder uses the CH made-up date.",
  },
  {
    companyNumber: "00445790", name: "TESCO PLC", kind: "large-group", format: "pdf",
    transactionId: "MzUzNDMwNDQ5M2FkaXF6a2N4",
    notes: "236-page group accounts scan, kept for page-finding (WP-BE15). No figures keyed from it in part 1.",
  },
  {
    companyNumber: "03454787", name: "BUSY BEES NURSERIES LIMITED", kind: "ixbrl", format: "xhtml",
    transactionId: "MzU0MjUzMDgyM2FkaXF6a2N4",
    notes: "The one iXBRL filer in the audit sample (finding 17). Figures are tag-derived through lib/sources/ixbrl.ts.",
  },
  {
    companyNumber: "00861615", name: "BUSY BEES DAY NURSERIES LIMITED", kind: "ixbrl", format: "xhtml",
    transactionId: "MzUzODA1MDYzNGFkaXF6a2N4",
    notes: "STAND-IN, replace in WP-BE17. Dormant accounts (9 pages), not a mid-size trading company. Twenty lookups found no mid-size private iXBRL filer: Gymshark, Richer Sounds, Hotel Chocolat, Charles Tyrwhitt, Bettys & Taylors and Pure Gym all file PDF only. This sibling of Busy Bees Nurseries was the one iXBRL filing reached inside the budget.",
  },
  {
    companyNumber: "00769170", name: "TRAVELODGE HOTELS LIMITED", kind: "scan-full", format: "pdf",
    transactionId: "MzQ2NTM4NzUzM2FkaXF6a2N4",
    notes: "Amended accounts (AAMD). The newest accounts-category filing is the amendment, filed 7 May 2025 over the AA of 14 Apr 2025 for the same year end.",
  },
  {
    companyNumber: "02103564", name: "MATALAN RETAIL LTD.", kind: "scan-full", format: "pdf",
    transactionId: "MzUzNzUwNjA4OGFkaXF6a2N4",
    notes: "Full accounts scan, 86 pages.",
  },
  {
    companyNumber: "01404552", name: "PIZZAEXPRESS LIMITED", kind: "scan-full", format: "pdf",
    transactionId: "MzQ4MjMyMTE4OWFkaXF6a2N4",
    notes: "Full accounts scan, 26 pages.",
  },
  {
    companyNumber: "00771335", name: "SOLID STATE PLC", kind: "scan-group", format: "pdf",
    transactionId: "MzUzNTQzMzAzOGFkaXF6a2N4",
    notes: "AIM group accounts scan, 140 pages.",
  },
];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function authHeader(): string {
  const key = process.env.CH_API_KEY;
  if (!key) throw new Error("CH_API_KEY not set");
  return `Basic ${Buffer.from(`${key}:`).toString("base64")}`;
}

let chRequests = 0;
async function chJson<T>(url: string): Promise<T> {
  await sleep(GAP_MS);
  chRequests++;
  const full = url.startsWith("http") ? url : `${CH_BASE}${url}`;
  const res = await fetch(full, { headers: { Authorization: authHeader(), Accept: "application/json" } });
  if (!res.ok) throw new Error(`Companies House ${res.status} for ${url}`);
  return (await res.json()) as T;
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function folderBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? folderBytes(p) : statSync(p).size;
  }
  return total;
}

// "accounts-amended-with-accounts-type-full" -> "full"
function accountsTypeOf(description: string): string {
  const m = description.match(/accounts-type-(.+)$/);
  return m ? m[1] : description;
}

async function pdfFacts(buf: Uint8Array): Promise<{ pageCount: number | null; textLayerChars: number }> {
  let pageCount: number | null = null;
  try {
    const { getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    pageCount = pdf.numPages;
  } catch {
    pageCount = null;
  }
  const text = await pdfToText(new Uint8Array(buf));
  return { pageCount, textLayerChars: text.length };
}

interface FilingItem {
  type: string;
  date: string;
  description: string;
  description_values?: { made_up_date?: string };
  pages?: number;
  links?: { document_metadata?: string };
}
interface DocMeta {
  links?: { document?: string };
  resources?: Record<string, unknown>;
}

// Write the bytes if they fit the size rule. Returns whether they were written.
function writeIfFits(dir: string, file: string, buf: Uint8Array, check: boolean): boolean {
  const target = join(dir, file);
  const already = existsSync(target) ? statSync(target).size : 0;
  const fits = buf.length <= FILE_LIMIT && folderBytes(FIXTURES) - already + buf.length <= FOLDER_LIMIT;
  if (fits && !check) writeFileSync(target, buf);
  return fits;
}

async function fetchChFiling(companyNumber: string, transactionId: string, accept: string) {
  const item = await chJson<FilingItem>(`/company/${companyNumber}/filing-history/${transactionId}`);
  const metaUrl = item.links?.document_metadata;
  if (!metaUrl) throw new Error(`no document for ${companyNumber} ${transactionId}`);
  const meta = await chJson<DocMeta>(metaUrl);
  const resources = Object.keys(meta.resources ?? {});
  const contentUrl = meta.links?.document;
  if (!contentUrl || !resources.includes(accept)) {
    throw new Error(`${companyNumber} ${transactionId} offers ${resources.join(", ") || "nothing"}, not ${accept}`);
  }
  const buf = await fetchChDocument(contentUrl, authHeader(), {
    accept,
    beforeAttempt: async () => {
      await sleep(GAP_MS);
      chRequests++;
    },
  });
  if (!buf) throw new Error(`download failed for ${companyNumber} ${transactionId}`);
  return { item, metaUrl, resources, buf };
}

async function freezeCh(spec: FilingSpec, check: boolean) {
  const accept = spec.format === "xhtml" ? "application/xhtml+xml" : "application/pdf";
  const { item, metaUrl, resources, buf } = await fetchChFiling(spec.companyNumber, spec.transactionId!, accept);
  const madeUpDate = item.description_values?.made_up_date ?? "";
  const dir = join(FIXTURES, `${spec.companyNumber}-${madeUpDate}${spec.folderSuffix ? "-" + spec.folderSuffix : ""}`);
  if (!check) mkdirSync(dir, { recursive: true });

  const file = spec.format === "xhtml" ? "filing.xhtml" : "filing.pdf";
  const hash = sha256(buf);
  const facts = spec.format === "pdf" ? await pdfFacts(buf) : { pageCount: null, textLayerChars: null };
  const committed = writeIfFits(dir, file, buf, check);

  const meta: Record<string, unknown> = {
    companyNumber: spec.companyNumber,
    companyName: spec.name,
    transactionId: spec.transactionId,
    filingType: item.type,
    filedOn: item.date,
    madeUpDate,
    accountsType: accountsTypeOf(item.description),
    pageCount: facts.pageCount ?? item.pages ?? null,
    chPages: item.pages ?? null,
    file,
    format: spec.format,
    resourcesOffered: resources,
    bytes: buf.length,
    sha256: hash,
    documentMetadataUrl: metaUrl,
    filingHistoryUrl: `${CH_BASE}/company/${spec.companyNumber}/filing-history/${spec.transactionId}`,
    publicRecordUrl: `https://find-and-update.company-information.service.gov.uk/company/${spec.companyNumber}/filing-history`,
    textLayerChars: facts.textLayerChars,
    bytesCommitted: committed,
    kind: spec.kind,
    notes: spec.notes,
    frozenOn: new Date().toISOString().slice(0, 10),
  };

  if (spec.parentTransactionId) {
    const p = await fetchChFiling(spec.companyNumber, spec.parentTransactionId, "application/pdf");
    const pf = await pdfFacts(p.buf);
    meta.parent = {
      transactionId: spec.parentTransactionId,
      filingType: p.item.type,
      filedOn: p.item.date,
      file: "parent.pdf",
      pageCount: pf.pageCount ?? p.item.pages ?? null,
      bytes: p.buf.length,
      sha256: sha256(p.buf),
      documentMetadataUrl: p.metaUrl,
      textLayerChars: pf.textLayerChars,
      bytesCommitted: writeIfFits(dir, "parent.pdf", p.buf, check),
    };
  }
  return { dir, meta };
}

interface FxoFilings {
  data?: { attributes?: { fxo_id?: string; json_url?: string; period_end?: string; date_added?: string; package_url?: string; viewer_url?: string } }[];
}

async function freezeEsef(spec: FilingSpec, check: boolean) {
  const list = await fetch(`${FXO_BASE}/api/entities/${spec.lei}/filings?sort=-date_added&page%5Bsize%5D=5`, {
    headers: { Accept: "application/vnd.api+json" },
  }).then((r) => r.json() as Promise<FxoFilings>);
  const rows = (list.data ?? []).map((d) => d.attributes ?? {});
  const a = spec.fxoId ? rows.find((r) => r.fxo_id === spec.fxoId) : rows[0];
  if (!a?.json_url) throw new Error(`no ESEF filing for LEI ${spec.lei}`);
  const res = await fetch(`${FXO_BASE}${a.json_url}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`filings.xbrl.org ${res.status} for ${a.json_url}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const madeUpDate = "2026-02-28"; // Tesco's 52/53-week year end, as on the CH AA for the same year
  const dir = join(FIXTURES, `${spec.companyNumber}-${madeUpDate}${spec.folderSuffix ? "-" + spec.folderSuffix : ""}`);
  if (!check) mkdirSync(dir, { recursive: true });
  const committed = writeIfFits(dir, "filing.json", buf, check);
  const meta = {
    companyNumber: spec.companyNumber,
    companyName: spec.name,
    lei: spec.lei,
    fxoId: a.fxo_id ?? null,
    transactionId: null,
    filingType: "ESEF",
    filedOn: a.date_added ?? null,
    madeUpDate,
    xbrlPeriodEnd: a.period_end ?? null,
    accountsType: "group (IFRS consolidated, ESEF)",
    pageCount: null,
    file: "filing.json",
    format: "esef",
    bytes: buf.length,
    sha256: sha256(buf),
    documentUrl: `${FXO_BASE}${a.json_url}`,
    packageUrl: a.package_url ? `${FXO_BASE}${a.package_url}` : null,
    viewerUrl: a.viewer_url ? `${FXO_BASE}${a.viewer_url}` : null,
    textLayerChars: null,
    bytesCommitted: committed,
    kind: spec.kind,
    notes: spec.notes,
    frozenOn: new Date().toISOString().slice(0, 10),
  };
  return { dir, meta };
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const only = args.filter((a) => !a.startsWith("--"));
  const specs = only.length ? FILINGS.filter((f) => only.includes(f.companyNumber) || only.includes(f.transactionId ?? "")) : FILINGS;
  if (!check) mkdirSync(FIXTURES, { recursive: true });

  for (const spec of specs) {
    try {
      const { dir, meta } = spec.format === "esef" ? await freezeEsef(spec, check) : await freezeCh(spec, check);
      const metaPath = join(dir, "meta.json");
      if (check) {
        const old = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : null;
        const same = old && old.sha256 === meta.sha256;
        console.log(`${same ? "same" : "DIFFERENT"}  ${spec.companyNumber} ${spec.kind}  sha256 ${String(meta.sha256).slice(0, 12)}`);
      } else {
        writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
        console.log(`frozen  ${spec.companyNumber} ${spec.kind}  ${meta.bytes} bytes  pages ${meta.pageCount}  text ${meta.textLayerChars}  committed ${meta.bytesCommitted}`);
      }
    } catch (e) {
      console.log(`FAILED  ${spec.companyNumber} ${spec.kind}  ${(e as Error).message}`);
    }
  }
  console.log(`companies house requests ${chRequests}; folder bytes ${folderBytes(FIXTURES)}`);
}

main();
