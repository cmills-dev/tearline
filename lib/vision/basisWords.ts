// lib/vision/basisWords.ts
// What printed words say about whose figures they are: the group's or the parent company's own.
// Shared by the scan verifier (lib/vision/verify.ts, WP-BE18) and the text-layer extractor
// (lib/sources/pdfAccounts.ts, WP-GRPCHK), so both read a heading the same way. Words only: no
// model, no layout.

export const BASIS_ABSTAIN = "company-only statement in a group filing";

export type HeadingBasis = "group" | "company" | "mixed" | "none";

// What a printed heading says about whose statement it is. "Consolidated and company balance
// sheets" is "mixed": it covers both, so on its own it establishes neither.
export function headingBasis(text: string | null | undefined): HeadingBasis {
  const t = (text ?? "").trim();
  if (!t) return "none";
  const group = /\b(consolidated|group)\b/i.test(t);
  const company = /\b(company|parent)\b/i.test(t);
  return group && company ? "mixed" : group ? "group" : company ? "company" : "none";
}

// A heading that names one of the group's statements: "Consolidated balance sheet", "Group income
// statement", "Notes to the consolidated financial statements". Only a statement heading counts.
// "Amounts owed to group undertakings" is a single company's note, and treating a single company
// as a group would abstain its every figure for want of the word "group".
const GROUP_STATEMENT =
  /\b(?:consolidated|group)\b(?:[^.]{0,40}?)\b(?:balance sheets?|statements? of financial position|income statements?|profit and loss accounts?|statements? of (?:comprehensive )?income|statements? of profit or loss|cash ?flow statements?|statements? of cash ?flows?|statements? of changes in equity|financial statements)\b/i;

export function printsGroupStatement(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  return !!t && GROUP_STATEMENT.test(t);
}

// Any statement heading, whoever's it is. The text-layer extractor uses it to know which
// statement a row sits under.
const STATEMENT =
  /\b(?:balance sheets?|statements? of financial position|income statements?|profit and loss accounts?|statements? of (?:comprehensive )?income|statements? of profit or loss|cash ?flow statements?|statements? of cash ?flows?|statements? of changes in equity|notes to the\b[^.]{0,40}\bfinancial statements)\b/i;

export function isStatementHeading(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  return !!t && STATEMENT.test(t);
}

// A row of column captions such as "Group Company", "GROUP COMPANY" or "Group 2025 2024 Company
// 2025 2024": nothing but basis words, years, dates, units and period words. Returns the basis
// words in the order printed, or null when the line is not such a row. "Consolidated" and
// "Group" are the group's; "Company" and "Parent" (and "Parent company") the company's.
const CAPTION_FILLER =
  /\b(?:\d{1,2}\s+[a-z]+\s+\d{4}|\d{4}|£\s*['’]?0{3}|£m|£bn|£|m|bn|000|note|notes|restated|as|at|weeks?|months?|year|ended|period|the|and|\d+)\b|['’£$€()*,.\-–—]/gi;
const MONTHS = /\b(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/gi;

export function captionSpans(line: string): ("group" | "company")[] | null {
  const words = line.match(/\b(?:consolidated|group|parent company|parent|company)\b/gi);
  if (!words || words.length === 0) return null;
  const rest = line
    .replace(/\b(?:consolidated|group|parent company|parent|company)\b/gi, " ")
    .replace(MONTHS, " ")
    .replace(CAPTION_FILLER, " ")
    .trim();
  if (rest.length > 0) return null;
  return words.map((w) => (/^(consolidated|group)$/i.test(w) ? "group" : "company"));
}
