// lib/resolve/index.ts
// Public surface of the resolver. WP-BE04 and WP-BE06 import from here.

export { resolveCompany, MAX_CANDIDATES, PROFILE_LOOKUPS, FILING_LOOKUPS } from "./resolve";
export { createResolveClient, fetchAccountsFilingHistory } from "./chClient";
export { classifyInput, isOverseasNumber, overseasReason, type InputClass } from "./numbers";
export { normaliseCompanyName, splitLegalForm, compactCore, type LegalForm } from "./normalise";
export { matchName, rankKey, statusTier, filesAccounts, isOverseasRegistration } from "./rank";
export {
  selectLatestAccountsFiling,
  latestAccountsFiling,
  hasAccountsFiling,
  documentFormats,
  type SelectedAccountsFiling,
  type DocumentFormats,
} from "./filings";
export {
  accountsTypeLabel,
  labelForAccountsTypeKey,
  isSubstantiveAccounts,
  type AccountsTypeLabel,
} from "./accountsType";
export { esefHint, mayFileEsef } from "./esefRoute";
export type {
  Candidate,
  ChFilingItem,
  ChProfile,
  ChSearchItem,
  ChSearchResult,
  EsefHint,
  MatchKind,
  ResolveClient,
  ResolveResult,
} from "./types";
