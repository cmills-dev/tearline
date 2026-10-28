// lib/resolve/accountsType.ts
// Plain labels for Companies House accounts types.
//
// The register uses one vocabulary on the profile (accounts.last_accounts.type, e.g.
// "audit-exemption-subsidiary") and wraps the same words in filing descriptions
// ("accounts-with-accounts-type-group"). Both map here. Anything not listed, or null, is
// "unknown". Nothing falls through to "filleted" (audit finding 8).

export type AccountsTypeLabel =
  | "full"
  | "group"
  | "small"
  | "medium"
  | "micro-entity"
  | "dormant"
  | "audit-exempt subsidiary"
  | "filing-exempt subsidiary"
  | "filleted"
  | "abridged"
  | "total exemption full"
  | "total exemption small"
  | "unaudited abridged"
  | "initial"
  | "interim"
  | "partial exemption"
  | "unknown";

const LABELS: Record<string, AccountsTypeLabel> = {
  full: "full",
  group: "group",
  small: "small",
  medium: "medium",
  "micro-entity": "micro-entity",
  dormant: "dormant",
  "full-group": "group",
  "audit-exemption-subsidiary": "audit-exempt subsidiary",
  // The register's own filing descriptions spell it this way.
  "audit-exemption-subsiduary": "audit-exempt subsidiary",
  "filing-exemption-subsidiary": "filing-exempt subsidiary",
  "filing-exemption-subsiduary": "filing-exempt subsidiary",
  filleted: "filleted",
  abridged: "abridged",
  "audited-abridged": "abridged",
  "total-exemption-full": "total exemption full",
  "total-exemption-small": "total exemption small",
  "unaudited-abridged": "unaudited abridged",
  initial: "initial",
  interim: "interim",
  "partial-exemption": "partial exemption",
};

const DESCRIPTION_PREFIXES = ["accounts-with-accounts-type-", "accounts-amended-with-accounts-type-"];

// A register accounts-type key, or a filing description that carries one, to its label.
export function labelForAccountsTypeKey(key: string | null | undefined): AccountsTypeLabel {
  if (!key) return "unknown";
  const k = key.trim().toLowerCase();
  const prefix = DESCRIPTION_PREFIXES.find((p) => k.startsWith(p));
  const bare = prefix ? k.slice(prefix.length) : k;
  return Object.prototype.hasOwnProperty.call(LABELS, bare) ? LABELS[bare] : "unknown";
}

export function accountsTypeLabel(
  profile: { accounts?: { last_accounts?: { type?: string | null } } } | null | undefined
): AccountsTypeLabel {
  return labelForAccountsTypeKey(profile?.accounts?.last_accounts?.type);
}

// Accounts that carry real trading figures, as opposed to a shell's or a dormant company's.
export function isSubstantiveAccounts(label: AccountsTypeLabel): boolean {
  return label !== "micro-entity" && label !== "dormant" && label !== "unknown";
}
