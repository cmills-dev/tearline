// lib/resolve/normalise.ts
// Company name normalisation for matching against the register.
//
// Unlike gleif.normaliseName, which throws legal forms away, this keeps the form as a
// canonical token (LTD, PLC, LLP) so "Irwin Mitchell LLP" does not silently equal
// "IRWIN MITCHELL LIMITED". Matching then compares the core and checks the forms agree.

export type LegalForm = "LTD" | "PLC" | "LLP";

// Longest phrases first, so "PUBLIC LIMITED COMPANY" is not half-eaten by "LIMITED".
const FORM_PHRASES: Array<[RegExp, LegalForm]> = [
  [/\bPUBLIC LIMITED COMPANY\b/g, "PLC"],
  [/\bCWMNI CYFYNGEDIG CYHOEDDUS\b/g, "PLC"],
  [/\bLIMITED LIABILITY PARTNERSHIP\b/g, "LLP"],
  [/\bPARTNERIAETH ATEBOLRWYDD CYFYNGEDIG\b/g, "LLP"],
  [/\bLIMITED\b/g, "LTD"],
  [/\bCYFYNGEDIG\b/g, "LTD"],
  // The short Welsh forms are also ordinary letters ("CCC GROUP"), so only at the end.
  [/\bCYF$/g, "LTD"],
  [/\bCCC$/g, "PLC"],
];
const FORMS = new Set<string>(["LTD", "PLC", "LLP"]);

// Accents folded away, for matching. NFKD and stripping the combining marks handles every letter
// that decomposes (é, ü, ç). It does nothing for the letters that do not (Ø, Æ, Œ, Ł, Đ), and the
// punctuation step after it used to delete them, so "Ørsted" became "RSTED" and "Mærsk" became
// "M RSK" and neither could ever match the register (RS-06 finding 5).
//
// Those letters are folded by asking Intl.Collator, the Unicode collation's own answer to "is this
// the same letter ignoring accents and case", which one or two of A to Z it equals: Ø is O, Æ is
// AE, ß is SS. A Collator compares; it gives no key, and the names here become map keys and are
// searched word by word, so the key is built from its verdicts one letter at a time and
// remembered. A letter it equates with nothing in A to Z (Þ, Ŧ, and every Cyrillic or Greek
// letter, including the ones that look Latin) is left alone, and the caller drops it as before.
const BASE_LETTER = new Intl.Collator("en", { sensitivity: "base" });
const AZ = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
const SPELLINGS = [...AZ, ...AZ.flatMap((a) => AZ.map((b) => a + b))];
const folded = new Map<string, string>();

function foldLetter(ch: string): string {
  let out = folded.get(ch);
  if (out === undefined) {
    out = /\p{L}/u.test(ch) ? SPELLINGS.find((s) => BASE_LETTER.compare(ch, s) === 0) ?? ch : ch;
    folded.set(ch, out);
  }
  return out;
}

export function foldDiacritics(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\x00-\x7F]/gu, foldLetter);
}

// Uppercase, fold accents, "&" to "AND", drop apostrophes, other punctuation to spaces,
// canonical legal forms, no leading or trailing "THE", single spaces.
export function normaliseCompanyName(s: string): string {
  let out = foldDiacritics(s)
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/['’`]/g, "")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const [re, form] of FORM_PHRASES) out = out.replace(re, form);
  const tokens = out.split(" ").filter(Boolean);
  if (tokens[0] === "THE" && tokens.length > 1) tokens.shift();
  if (tokens[tokens.length - 1] === "THE" && tokens.length > 1) tokens.pop();
  return tokens.join(" ");
}

// The name without its trailing legal form, and the form if there was one.
export function splitLegalForm(s: string): { core: string; form: LegalForm | null } {
  const tokens = normaliseCompanyName(s).split(" ").filter(Boolean);
  let form: LegalForm | null = null;
  // "BOOTS COMPANY PLC THE" has already lost its THE; a form is only read at the end.
  if (tokens.length > 1 && FORMS.has(tokens[tokens.length - 1])) form = tokens.pop() as LegalForm;
  return { core: tokens.join(" "), form };
}

// The core with every space removed, so "PIZZAEXPRESS" equals "PIZZA EXPRESS".
export function compactCore(s: string): string {
  return splitLegalForm(s).core.replace(/ /g, "");
}
