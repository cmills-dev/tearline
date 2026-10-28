// lib/vision/scale.ts
// The printed scale caption to a multiplier.
//
// The reader returns the figure exactly as printed and the caption printed above it, and never
// applies one to the other (lib/vision/prompt.ts rule 5). This is where the two meet, and it is
// the only place a Companies House figure is multiplied. The classic wrong answer in this
// codebase is a 1,000x error, so an unrecognised caption returns null and the line abstains
// rather than being landed at face value.

// Captions seen on the frozen UK gold filings: "£'000", "£000", "£ '000", "£'m", "£m",
// "£ million", "in thousands", "£". Apostrophes come back as ' or the typographic ’.
const THOUSANDS = /(^|[^0-9])['’]?\s*0{3}\s*$|\bthousand/;
const MILLIONS = /['’]?\s*0{6}\s*$|\bmillion|(^|[^a-z0-9])m\s*$/;
const BILLIONS = /\bbillion|['’]?\s*0{9}\s*$|(^|[^a-z0-9])bn\s*$/;
const UNITS = /^[£$€]?\s*$|\bpounds?\b|\bunits?\b|\bwhole pounds\b/;

// The multiplier a caption declares, or null when it declares nothing this code understands.
// Order matters: billions and millions are tested before thousands so "£'000m" cannot be read
// as thousands.
export function scaleFromCaption(caption: string | null | undefined): number | null {
  if (caption === null || caption === undefined) return null;
  const c = caption
    .toLowerCase()
    .replace(/[()\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    // "figures in £'000", "amounts are stated in £m", "all amounts in £000s"
    .replace(/^(all |the )?(figures?|amounts?|numbers?)( are| is)?( stated| shown| presented)?( in)?\s*/, "")
    .replace(/^in\s+/, "")
    .replace(/s$/, "")
    .trim();
  if (c.length === 0) return null;
  if (BILLIONS.test(c)) return 1_000_000_000;
  if (MILLIONS.test(c)) return 1_000_000;
  if (THOUSANDS.test(c)) return 1_000;
  if (UNITS.test(c)) return 1;
  return null;
}

// Binary floating point cannot hold 8.3, so 8.3 x 1,000,000 is 8,300,000.000000001. A figure in
// pounds is rounded to the penny, which is exact for every printed caption, rather than carried
// with a tail that would show up in a ratio or a rendered number.
export function toPence(value: number): number {
  return Math.round(value * 100) / 100;
}

// The figure in pounds: the printed value with its caption applied. Null when the caption is
// not understood, which is an abstention, never a figure at face value.
export function scaledValue(printedValue: number, caption: string | null | undefined): number | null {
  const scale = scaleFromCaption(caption);
  if (scale === null) return null;
  const v = printedValue * scale;
  return Number.isFinite(v) ? toPence(v) : null;
}
