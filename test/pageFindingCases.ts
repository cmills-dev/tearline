// test/pageFindingCases.ts
// The three large group scans WP-BE15 is measured on, and how a recorded request is told apart
// from another, shared by the recorder (test/record/largeFilings.ts) and the replaying tests
// (test/pageFinding.test.ts).

import { CONTENTS_SYSTEM_PROMPT, CLASSIFY_SYSTEM_PROMPT } from "../lib/vision/pages";
import { VISION_SYSTEM_PROMPT } from "../lib/vision/prompt";
import { FACILITY_READ_SYSTEM_PROMPT } from "../lib/vision/capitalStructure";

export interface LargeFiling {
  number: string;
  name: string;
  folder: string;
  transactionId: string;
  pageCount: number;
  madeUpDate: string;
}

export const LARGE_FILINGS: LargeFiling[] = [
  { number: "03213782", name: "Topps Tiles", folder: "03213782-2025-09-27", transactionId: "MzUwNzM2NzQwNGFkaXF6a2N4", pageCount: 226, madeUpDate: "2025-09-27" },
  { number: "00211475", name: "James Fisher", folder: "00211475-2025-12-31", transactionId: "MzUyMzIyMjQwNmFkaXF6a2N4", pageCount: 210, madeUpDate: "2025-12-31" },
  { number: "00445790", name: "Tesco (scan)", folder: "00445790-2026-02-28", transactionId: "MzUzNDMwNDQ5M2FkaXF6a2N4", pageCount: 236, madeUpDate: "2026-02-28" },
];

// "contents", "classify:<first page>-<last page>", "first-read", "facility-read" (WP-BE16) or
// "second-read", from a Messages
// API request body. Classification chunks run concurrently, so a replay must answer each chunk by
// the pages it asks about, not by the order the requests arrive in.
export function stageOf(body: any): string {
  const system = String(body?.system ?? "");
  const userText = ((body?.messages?.[0]?.content ?? []) as any[]).filter((b) => b.type === "text").map((b) => b.text).join(" ");
  if (system === CONTENTS_SYSTEM_PROMPT) return "contents";
  if (system === CLASSIFY_SYSTEM_PROMPT) {
    const m = userText.match(/are pages (\d+) to (\d+) of a filing/);
    return m ? `classify:${m[1]}-${m[2]}` : "classify:?";
  }
  if (system === VISION_SYSTEM_PROMPT) return "first-read";
  if (system === FACILITY_READ_SYSTEM_PROMPT) return "facility-read";
  return "second-read";
}
