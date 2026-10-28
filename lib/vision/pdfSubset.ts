// lib/vision/pdfSubset.ts
// Build a PDF holding only some pages of another, so the second read of a scan can be sent the
// pages the first read cited and nothing else (WP-BE05).
//
// This is a deliberately small writer, not a PDF library. It handles the classic structure that
// Companies House scans use (tiff2pdf output: top-level objects, no object streams, no
// encryption): it walks the page tree, copies each chosen page and every object that page
// reaches under the same object numbers, and writes a new catalogue, page tree and
// cross-reference table around them. Anything it does not understand returns null, and the
// caller abstains rather than sending the whole document.
// WP-BE15 brings pdf-lib for page subsets of large group filings; this stays as the narrow,
// dependency-free path the verifier needs tonight.

const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("latin1");

interface RawObject {
  num: number;
  dict: string; // the object's text before any stream, without "n g obj"
  raw: string; // the whole object from "n g obj" to "endobj" inclusive, stream length made true
}

interface ParsedPdf {
  objects: Map<number, RawObject>;
  rootRef: number;
}

// Read every top-level object by scanning the file from the front, rather than trusting the
// cross-reference table. The Companies House scans need this: go-tiff2pdf writes a table whose
// offsets miss, and indirect /Length objects that say 0 for image streams of hundreds of
// kilobytes. PDF viewers recover from both by scanning, and so does this. A stream ends at the
// first "endstream" that is followed by "endobj". A later object with the same number replaces
// an earlier one, as an incremental update would. Null for anything encrypted, for a file with
// no trailer naming a root (a cross-reference stream), and for any structure the scan cannot
// follow to the end.
function parsePdf(bytes: Uint8Array): ParsedPdf | null {
  const text = latin1(bytes);
  if (!text.startsWith("%PDF-")) return null;
  const objects = new Map<number, RawObject>();
  const header = /(\d+)\s+(\d+)\s+obj\b/g;
  let pos = 0;
  for (;;) {
    header.lastIndex = pos;
    const m = header.exec(text);
    if (!m) break;
    // Anything between objects other than whitespace, comments or the xref section means the
    // match is inside something the scan does not understand.
    const gap = text.slice(pos, m.index);
    if (pos > 0 && !/^(\s|%[^\r\n]*|xref[\s\S]*?trailer[\s\S]*?%%EOF)*$/.test(gap)) return null;
    const num = Number(m[1]);
    const bodyStart = m.index + m[0].length;
    const endobjAt = text.indexOf("endobj", bodyStart);
    if (endobjAt < 0) return null;
    const streamMatch = /\bstream(\r\n|\n|\r)/.exec(text.slice(bodyStart, endobjAt + 1));
    if (!streamMatch) {
      const dict = text.slice(bodyStart, endobjAt);
      objects.set(num, { num, dict, raw: text.slice(m.index, endobjAt + 6) });
      pos = endobjAt + 6;
      continue;
    }
    const dict = text.slice(bodyStart, bodyStart + streamMatch.index);
    const dataStart = bodyStart + streamMatch.index + streamMatch[0].length;
    let search = dataStart;
    let dataEnd = -1;
    let objEnd = -1;
    while (search < text.length) {
      const es = text.indexOf("endstream", search);
      if (es < 0) return null;
      const tail = /^\s*endobj/.exec(text.slice(es + 9, es + 9 + 16));
      if (tail) {
        dataEnd = es;
        objEnd = es + 9 + tail[0].length;
        break;
      }
      search = es + 9;
    }
    if (dataEnd < 0) return null;
    // The end-of-line before "endstream" is not part of the data.
    if (text[dataEnd - 1] === "\n") dataEnd--;
    if (text[dataEnd - 1] === "\r") dataEnd--;
    const length = dataEnd - dataStart;
    const trueDict = /\/Length\s+\d+(\s+\d+\s+R)?/.test(dict)
      ? dict.replace(/\/Length\s+\d+(\s+\d+\s+R)?/, `/Length ${length}`)
      : null;
    if (trueDict === null) return null;
    const raw = `${num} ${m[2]} obj${trueDict}stream\n${text.slice(dataStart, dataEnd)}\nendstream\nendobj`;
    objects.set(num, { num, dict: trueDict, raw });
    pos = objEnd;
  }
  const trailerAt = text.lastIndexOf("trailer");
  if (trailerAt < 0) return null;
  const trailer = text.slice(trailerAt);
  if (/\/Encrypt\b/.test(trailer)) return null;
  const root = trailer.match(/\/Root\s+(\d+)\s+\d+\s+R/);
  if (!root || objects.size === 0) return null;
  return { objects, rootRef: Number(root[1]) };
}

function readObject(pdf: ParsedPdf, num: number): RawObject | null {
  return pdf.objects.get(num) ?? null;
}

const refsIn = (s: string): number[] => [...s.matchAll(/(\d+)\s+(\d+)\s+R\b/g)].map((m) => Number(m[1]));

// The page objects in reading order, from the page tree rather than from file order.
function pageObjects(pdf: ParsedPdf): number[] | null {
  const root = readObject(pdf, pdf.rootRef);
  const pagesRef = root?.dict.match(/\/Pages\s+(\d+)\s+\d+\s+R/);
  if (!pagesRef) return null;
  const out: number[] = [];
  const walk = (num: number, depth: number): boolean => {
    if (depth > 32) return false;
    const node = readObject(pdf, num);
    if (!node) return false;
    if (/\/Type\s*\/Pages\b/.test(node.dict)) {
      // Attributes a Pages node passes down would be lost when the page is re-parented.
      if (/\/(Resources|MediaBox|CropBox|Rotate)\b/.test(node.dict)) return false;
      const kids = node.dict.match(/\/Kids\s*\[([^\]]*)\]/);
      if (!kids) return false;
      return refsIn(kids[1]).every((k) => walk(k, depth + 1));
    }
    if (/\/Type\s*\/Page\b/.test(node.dict)) {
      out.push(num);
      return true;
    }
    return false;
  };
  return walk(Number(pagesRef[1]), 0) ? out : null;
}

export function pdfPageCount(bytes: Uint8Array): number | null {
  const pdf = parsePdf(bytes);
  const pages = pdf ? pageObjects(pdf) : null;
  return pages ? pages.length : null;
}

export interface PdfSubset {
  bytes: Uint8Array;
  pages: number[]; // the original 1-based page indexes, in the order they appear in the subset
}

// A new PDF holding only the given 1-based pages, in ascending order with duplicates removed.
// Null when the source cannot be subset safely or a page is out of range. Page N of the subset
// is subset.pages[N - 1] of the original.
export function subsetPdfPages(bytes: Uint8Array, wanted: number[]): PdfSubset | null {
  const pdf = parsePdf(bytes);
  if (!pdf) return null;
  const all = pageObjects(pdf);
  if (!all) return null;
  const pages = [...new Set(wanted)].sort((a, b) => a - b);
  if (pages.length === 0 || pages.some((p) => !Number.isInteger(p) || p < 1 || p > all.length)) return null;

  // Copy every object the chosen pages reach, but never climb back up through /Parent.
  const keep = new Map<number, RawObject>();
  const stack = pages.map((p) => all[p - 1]);
  while (stack.length) {
    const num = stack.pop()!;
    if (keep.has(num)) continue;
    const obj = readObject(pdf, num);
    if (!obj) return null;
    keep.set(num, obj);
    for (const r of refsIn(obj.dict.replace(/\/Parent\s+\d+\s+\d+\s+R/g, ""))) {
      if (!keep.has(r)) stack.push(r);
    }
  }

  const maxNum = Math.max(...pdf.objects.keys());
  const pagesNum = maxNum + 1;
  const catalogNum = maxNum + 2;
  const pageNums = new Set(pages.map((p) => all[p - 1]));

  const chunks: string[] = ["%PDF-1.4\n%\xE2\xE3\xCF\xD3\n"];
  let offset = chunks[0].length;
  const written = new Map<number, number>();
  const emit = (num: number, raw: string) => {
    written.set(num, offset);
    const s = `${raw}\n`;
    chunks.push(s);
    offset += s.length;
  };
  for (const num of [...keep.keys()].sort((a, b) => a - b)) {
    const obj = keep.get(num)!;
    let raw = obj.raw;
    if (pageNums.has(num)) {
      // Only the dictionary part is rewritten; a page object carries no stream.
      raw = raw.replace(/\/Parent\s+\d+\s+\d+\s+R/, `/Parent ${pagesNum} 0 R`);
    }
    emit(num, raw);
  }
  const kids = pages.map((p) => `${all[p - 1]} 0 R`).join(" ");
  emit(pagesNum, `${pagesNum} 0 obj\n<< /Type /Pages /Kids [ ${kids} ] /Count ${pages.length} >>\nendobj`);
  emit(catalogNum, `${catalogNum} 0 obj\n<< /Type /Catalog /Pages ${pagesNum} 0 R >>\nendobj`);

  const size = catalogNum + 1;
  const xref: string[] = [`xref\n0 ${size}\n`, "0000000000 65535 f \n"];
  for (let n = 1; n < size; n++) {
    const at = written.get(n);
    xref.push(at === undefined ? "0000000000 65535 f \n" : `${String(at).padStart(10, "0")} 00000 n \n`);
  }
  chunks.push(...xref, `trailer\n<< /Size ${size} /Root ${catalogNum} 0 R >>\nstartxref\n${offset}\n%%EOF\n`);
  return { bytes: new Uint8Array(Buffer.from(chunks.join(""), "latin1")), pages };
}
