// test/pdfPages.ts
// What a cut PDF actually carries, for tests that check a request was sent the right pages.
//
// Comparing a request's bytes with the cutter's own output only proves the cutter agrees with
// itself. These compare page content: every Companies House scan page is one image, so a page was
// carried across intact exactly when its image stream is byte for byte the original's (RS-06).

import { PDFDict, PDFDocument, PDFName, PDFRawStream } from "pdf-lib";

// The raw bytes of every image and form a page draws, in resource order, one Buffer per page.
export async function pageImages(bytes: Uint8Array): Promise<Buffer[][]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPages().map((page) => {
    const xobjects = page.node.Resources()?.lookupMaybe(PDFName.of("XObject"), PDFDict);
    if (!xobjects) return [];
    return xobjects.entries().map(([, ref]) => Buffer.from((doc.context.lookup(ref) as PDFRawStream).contents));
  });
}

// True when `sent` holds exactly the given 1-based pages of `source`, in that order, each with
// the same image bytes and at least one image.
export async function carriesPages(sent: Uint8Array, source: Uint8Array, pages: number[]): Promise<boolean> {
  const [cut, all] = await Promise.all([pageImages(sent), pageImages(source)]);
  if (cut.length !== pages.length) return false;
  return pages.every((p, i) => {
    const want = all[p - 1];
    const got = cut[i];
    return !!want && want.length > 0 && got.length === want.length && got.every((b, j) => b.equals(want[j]));
  });
}
