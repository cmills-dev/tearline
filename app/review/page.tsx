// app/review/page.tsx
// The entity-resolution review queue. Server-rendered, tenant-scoped. Two bands:
//   1. Unresolved firm/company nodes, each with the LEI GLEIF would propose (name, jurisdiction,
//      confidence) so a human sees the evidence before confirming or rejecting the link.
//   2. Resolved nodes that share a canonical LEI - the same legal entity seen through two sources,
//      offered as merge candidates with the edges each side contributes shown as evidence.
// Every proposal follows the abstain discipline: an ambiguous name yields no proposal at all, so a
// mis-link is never one confirming click away from a name we could not pin down.

import Link from "next/link";
import { getTenantId } from "@/lib/tenant";
import { getGraphStore } from "@/lib/graph/store";
import { proposeLei, type LeiProposal } from "@/lib/graph/resolve";
import type { GraphNode } from "@/lib/graph/model";
import { ReviewButton } from "./actions";
import { BLANK } from "@/lib/format/format";
import { notFound } from "next/navigation";
import { isHiddenRoute } from "@/lib/config/launchRoutes";

export const dynamic = "force-dynamic";

const MAX_PROPOSALS = 25;

interface NodeEvidence {
  node: GraphNode;
  edgeCount: number;
  sources: string[];
}

export default async function ReviewPage() {
  // Hidden at launch (WP-FE01, FE-09): 404 unless SHOW_NON_LAUNCH_ROUTES brings it back.
  if (isHiddenRoute("/review")) notFound();
  const tenantId = await getTenantId();
  const store = getGraphStore();

  const all = tenantId ? await store.allNodes(tenantId) : [];

  // Band 1: unresolved firm/company nodes and their (abstaining) LEI proposals.
  const unresolved = all
    .filter((n) => n.resolutionStatus === "unresolved" && (n.kind === "firm" || n.kind === "company"))
    .slice(0, MAX_PROPOSALS);
  const proposals = await Promise.all(
    unresolved.map(async (n) => ({ node: n, proposal: await safePropose(n) })),
  );

  // Band 2: resolved nodes sharing a LEI - merge candidates, with each side's edges as evidence.
  const groups = tenantId ? await store.nodesSharingLei(tenantId) : [];
  const groupsWithEvidence = await Promise.all(
    groups.map(async (g) => {
      const nodes = await Promise.all(g.nodes.map((n) => evidenceFor(store, tenantId, n)));
      // Deterministic survivor: highest confidence, then lexically smallest id (matches the pass).
      const sorted = [...nodes].sort(
        (a, b) => b.node.resolutionConfidence - a.node.resolutionConfidence || a.node.id.localeCompare(b.node.id),
      );
      return { lei: g.lei, keep: sorted[0], drops: sorted.slice(1) };
    }),
  );

  return (
    <main className="frame doc">
      <section style={{ paddingTop: "2.2rem" }}>
        <span className="legend">Entity resolution · review queue</span>
        <h1 style={{ marginTop: "0.6rem", maxWidth: "24ch" }}>Confirm the links before they enter the graph.</h1>
        <p className="prose mt">
          A counterparty named in two sources is only the same firm once its canonical LEI agrees. This
          queue shows every name we could not pin down on our own and every pair that now shares an LEI,
          with the evidence attached. Nothing is linked or merged until you confirm it. An ambiguous name
          is left alone, never guessed.
        </p>

        <div className="mt">
          <ReviewButton payload={{ action: "run" }} variant="accent">
            Run resolution + merge pass
          </ReviewButton>
          <span className="legend" style={{ marginLeft: "0.8rem" }}>
            resolves name-only nodes and folds confident LEI duplicates
          </span>
        </div>

        {!tenantId && (
          <p className="prose mt" style={{ color: "var(--accent)" }}>
            No tenant in context. Sign in to review your desk&rsquo;s graph.
          </p>
        )}

        {/* ---- Band 1: unresolved nodes + proposed LEIs ---- */}
        <h2>Unresolved names ({proposals.length})</h2>
        {proposals.length === 0 ? (
          <p className="prose muted">Nothing awaiting resolution. Every firm/company node carries a canonical key.</p>
        ) : (
          <div className="refs mt">
            {proposals.map(({ node, proposal }) => (
              <div className="ref" key={node.id}>
                <div className="ref-head">
                  <span className="ref-cite">{node.displayName}</span>
                  <span className="tagchip">{node.kind}</span>
                  {node.firmRole && <span className="tagchip">{node.firmRole}</span>}
                  <span className="ptag mono">{node.id}</span>
                </div>
                {proposal ? (
                  <>
                    <ul className="ref-backs">
                      <li>
                        <span className="legend">Proposed LEI</span>
                        <span className="mono">{proposal.lei}</span>
                      </li>
                      <li>
                        <span className="legend">GLEIF legal name</span>
                        <span>{proposal.legalName || BLANK}</span>
                        <span className="ptag">
                          {proposal.jurisdiction} · {proposal.status}
                        </span>
                      </li>
                      <li>
                        <span className="legend">Confidence</span>
                        <span className="num">{(proposal.confidence * 100).toFixed(0)}%</span>
                        <span className="ptag">source: GLEIF name match</span>
                      </li>
                    </ul>
                    <div className="mt" style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
                      <ReviewButton
                        payload={{ action: "confirm-lei", nodeId: node.id, lei: proposal.lei, confidence: proposal.confidence }}
                        variant="accent"
                      >
                        Confirm this LEI
                      </ReviewButton>
                      <ReviewButton payload={{ action: "reject-lei", nodeId: node.id }}>Reject</ReviewButton>
                    </div>
                  </>
                ) : (
                  <p className="prose small muted" style={{ margin: "0.5rem 0 0" }}>
                    No confident GLEIF match. Abstained, left in the review band rather than guessed.
                  </p>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ---- Band 2: merge candidates sharing a LEI ---- */}
        <h2>Merge candidates ({groupsWithEvidence.length})</h2>
        {groupsWithEvidence.length === 0 ? (
          <p className="prose muted">No two nodes share a canonical LEI. Nothing to de-duplicate.</p>
        ) : (
          <div className="refs mt">
            {groupsWithEvidence.map((g) => (
              <div className="ref" key={g.lei}>
                <div className="ref-head">
                  <span className="legend">Shared LEI</span>
                  <span className="ref-cite mono">{g.lei}</span>
                </div>
                <p className="prose small muted" style={{ margin: "0.4rem 0 0.6rem" }}>
                  Survivor: <strong>{g.keep.node.displayName}</strong>{" "}
                  <span className="ptag mono">{g.keep.node.id}</span> ({g.keep.edgeCount} edge
                  {g.keep.edgeCount === 1 ? "" : "s"}
                  {g.keep.sources.length > 0 ? ` · ${g.keep.sources.join(", ")}` : ""}). The nodes below fold into it,
                  their edges repointed with provenance intact.
                </p>
                {g.drops.map((d) => (
                  <ul className="ref-backs" key={d.node.id}>
                    <li>
                      <span className="ref-cite">{d.node.displayName}</span>
                      <span className="ptag mono">{d.node.id}</span>
                      <span className="ptag">
                        {d.edgeCount} edge{d.edgeCount === 1 ? "" : "s"}
                        {d.sources.length > 0 ? ` · ${d.sources.join(", ")}` : ""}
                      </span>
                    </li>
                    <li>
                      <ReviewButton payload={{ action: "merge", keepId: g.keep.node.id, dropId: d.node.id }} variant="accent">
                        Merge into {g.keep.node.displayName}
                      </ReviewButton>
                    </li>
                  </ul>
                ))}
              </div>
            ))}
          </div>
        )}
      </section>

      <hr className="hairline" />
      <section>
        <span className="legend">
          <Link href="/" style={{ color: "var(--accent)" }}>
            ← Back to the entry field
          </Link>
        </span>
      </section>
    </main>
  );
}

// A proposal that never throws the render: a live GLEIF hiccup abstains, it does not 500 the queue.
async function safePropose(n: GraphNode): Promise<LeiProposal | null> {
  try {
    return await proposeLei(n);
  } catch {
    return null;
  }
}

async function evidenceFor(
  store: ReturnType<typeof getGraphStore>,
  tenantId: string,
  node: GraphNode,
): Promise<NodeEvidence> {
  const nbrs = tenantId ? await store.neighbours(tenantId, node.id) : [];
  const sources = [...new Set(nbrs.map((n) => n.edge.provenance.source).filter(Boolean))];
  return { node, edgeCount: nbrs.length, sources };
}
