// lib/resolve/candidates.ts
// The register candidates for a typed name, with no run behind them (WP-FE02, the route asked of
// the backend lane in docs/programme/reports/WP-FE02.md). The run entry shows these as a pick list
// and starts a run only when one is picked, so a lookup never writes a run record or spends the
// run throttle.
//
// This is the resolver and nothing else: no document fetch, no model call, nothing tenant-scoped.
// The answer's shape is the one app/components/runEntryFlow.ts already parses.

import { resolveCompany } from "./resolve";
import type { ResolveClient } from "./types";
import { toRunCandidate, type RunCandidate } from "../run/types";

export interface CandidatesAnswer {
  kind: "resolved" | "pick" | "none" | "excluded";
  candidates: RunCandidate[];
  suggested: string | null;
  reason: string;
}

export async function candidatesAnswer(q: string, client: ResolveClient): Promise<CandidatesAnswer> {
  const r = await resolveCompany(q, client);
  switch (r.kind) {
    case "resolved":
      return {
        kind: r.kind,
        candidates: [toRunCandidate(r.company, r.company.number)],
        suggested: r.company.number,
        reason: r.reason,
      };
    case "pick":
      return {
        kind: r.kind,
        candidates: r.candidates.map((c) => toRunCandidate(c, r.suggested)),
        suggested: r.suggested,
        reason: r.reason,
      };
    default:
      return { kind: r.kind, candidates: [], suggested: null, reason: r.reason };
  }
}
