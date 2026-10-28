// lib/resolve/numbers.ts
// Decide whether the text typed is a Companies House number or a name.
//
// A company number is 8 characters: 8 digits (England and Wales), or a 2-letter prefix and
// 6 digits. Case and spaces are tolerated. A bare 6 or 7 digit number is zero-padded, because
// people drop the leading zeros ("445790" is Tesco, 00445790). Overseas registrations are
// recognised but excluded: their accounts are filed abroad, so there is nothing UK to read.

export type InputClass =
  | { kind: "number"; number: string; register: string }
  | { kind: "excluded"; number: string; reason: string }
  | { kind: "name"; name: string };

// Prefixes of UK companies and LLPs whose accounts are filed at Companies House.
const UK_PREFIXES: Record<string, string> = {
  SC: "Scottish company",
  NI: "Northern Ireland company",
  OC: "English and Welsh LLP",
  SO: "Scottish LLP",
  NC: "Northern Ireland LLP",
  R0: "Northern Ireland company (pre-partition register)",
};

// Prefixes of overseas registrations. Each reason says in plain words why it is excluded.
const OVERSEAS_PREFIXES: Record<string, string> = {
  FC: "an overseas company registered in England and Wales (FC). Its accounts are the parent's foreign accounts, not UK statutory accounts",
  BR: "a UK branch of an overseas company (BR). A branch files no accounts of its own",
  SF: "an overseas company registered in Scotland (SF). Its accounts are the parent's foreign accounts, not UK statutory accounts",
  NF: "an overseas company registered in Northern Ireland (NF). Its accounts are the parent's foreign accounts, not UK statutory accounts",
  OE: "an entry on the Register of Overseas Entities (OE), which holds no accounts",
};

export function overseasReason(number: string): string | null {
  const prefix = number.slice(0, 2).toUpperCase();
  const why = OVERSEAS_PREFIXES[prefix];
  return why ? `${number} is ${why}.` : null;
}

export function isOverseasNumber(number: string): boolean {
  return overseasReason(number) !== null;
}

export function classifyInput(raw: string): InputClass {
  const compact = raw.replace(/\s+/g, "").toUpperCase();

  if (/^\d{6,8}$/.test(compact)) {
    return { kind: "number", number: compact.padStart(8, "0"), register: "England and Wales company" };
  }

  const m = /^([A-Z][A-Z0-9])(\d{6})$/.exec(compact);
  if (m) {
    const [, prefix] = m;
    if (UK_PREFIXES[prefix]) return { kind: "number", number: compact, register: UK_PREFIXES[prefix] };
    const reason = overseasReason(compact);
    if (reason) return { kind: "excluded", number: compact, reason };
  }

  return { kind: "name", name: raw.trim().replace(/\s+/g, " ") };
}
