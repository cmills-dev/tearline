// app/originate/page.tsx
// Engine C surface. Runs origination over an ILLUSTRATIVE scenario (a synthetic firm + a
// synthetic network + the two demo borrowers as targets) and renders each suggestion with
// its cited "why now" catalyst and its provenanced "why you" warm-intro path. Everything
// here is stamped illustrative; the same engine runs over a tenant's real onboarded graph.

import Link from "next/link";
import { manifestForKey } from "@/lib/engine/pipeline";
import { InMemoryGraphStore } from "@/lib/graph/store";
import type { GraphNode, GraphEdge } from "@/lib/graph/model";
import { originate, type Candidate } from "@/lib/originate/engine";
import { getTenantId } from "@/lib/tenant";
import { listSuggestions } from "@/lib/workspace";
import LivePanel from "./LivePanel";
import SignInGate from "@/app/components/SignInGate";
import { notFound } from "next/navigation";
import { isHiddenRoute } from "@/lib/config/launchRoutes";

export const dynamic = "force-dynamic";

const CH_CONFIGURED = !!process.env.CH_API_KEY;

const T = "illustrative";
const node = (id: string, kind: GraphNode["kind"], name: string, role?: GraphNode["firmRole"]): GraphNode => ({ id, tenantId: T, kind, firmRole: role, displayName: name, resolutionConfidence: 1, resolutionStatus: "resolved" });
const edge = (id: string, src: string, dst: string, rel: GraphEdge["rel"], conf: number, quote: string): GraphEdge => ({ id, tenantId: T, srcId: src, dstId: dst, rel, assertionType: "assertion", confidence: conf, visibility: rel === "knows" ? "tenant_private" : "shared", provenance: { source: "illustrative-demo", evidenceQuote: quote, retrievedAt: "2026-08-01" } });

async function buildScenario() {
  const store = new InMemoryGraphStore();
  await store.addNode(node("client-firm", "firm", "Our Desk (illustrative)"));
  await store.addNode(node("adviser1", "firm", "Illustrative Advisers LLP", "law"));
  await store.addNode(node("co:meridian", "company", "PROJECT MERIDIAN (illustrative)"));
  await store.addNode(node("co:redacta", "company", "PROJECT REDACTA (illustrative)"));
  // the firm knows an adviser (private), who advised one target (public-style)
  await store.addEdge(edge("s1", "client-firm", "adviser1", "knows", 0.9, "Our desk works closely with Illustrative Advisers LLP"));
  await store.addEdge(edge("s2", "adviser1", "co:meridian", "advised", 0.8, "Illustrative Advisers advised Project Meridian on its last refinancing"));
  // Redacta is deliberately left unconnected -> it will be a "cold" target.

  const candidates: Candidate[] = [
    { targetNodeId: "co:meridian", name: "PROJECT MERIDIAN (illustrative)", manifest: manifestForKey("meridian")! },
    { targetNodeId: "co:redacta", name: "PROJECT REDACTA (illustrative)", manifest: manifestForKey("redacta")! },
  ].filter((c) => !!c.manifest);

  return originate({ mandate: { maxLeverage: 6 }, tenantId: T, fromIds: ["client-firm"], candidates, store });
}

export default async function OriginatePage() {
  // Hidden at launch (WP-FE01, FE-09): 404 unless SHOW_NON_LAUNCH_ROUTES brings it back.
  if (isHiddenRoute("/originate")) notFound();
  const tenantId = await getTenantId();
  if (!tenantId) {
    return (
      <SignInGate
        legend="Engine C · originate for a real target"
        title="Sign in to originate."
        body="Origination runs over your desk's graph and saves shortlists to your tenant, which is bound to your account."
      />
    );
  }
  const result = await buildScenario();
  const shortlists = await listSuggestions(tenantId);

  return (
    <main className="frame doc">
      <section style={{ paddingTop: "2.2rem" }}>
        <span className="legend">Engine C · originate for a real target · live</span>
        <h1 style={{ marginTop: "0.6rem", maxWidth: "24ch" }}>Originate against a real company.</h1>
        <p className="prose mt">
          Enter a real Companies House number and, optionally, a mandate. We ingest the target&rsquo;s
          own network from its filings, compute a document-cited <strong>why now</strong>, and find the
          warmest provenanced path from your desk to it. If no catalyst is cited, we abstain and say so.
          {CH_CONFIGURED
            ? ""
            : " The live engine needs CH_API_KEY (free from Companies House); without it the panel returns an honest note."}
        </p>
        <LivePanel initialShortlists={shortlists} />
      </section>

      <hr className="hairline" />

      <section>
        <span className="legend">Engine C · origination of work · illustrative</span>
        <h1 style={{ marginTop: "0.6rem", maxWidth: "24ch" }}>New work, found from your network.</h1>
        <p className="prose mt">
          Each suggestion pairs a <strong>why now</strong> (a document-cited credit catalyst) with a
          <strong> why you</strong> (a real, provenanced path through your own network). A target is
          surfaced only when the catalyst is cited; a strong catalyst with no warm path is shown as
          &ldquo;cold&rdquo;, never linked by a guessed connection. This scenario is illustrative.
        </p>

        <div className="mt" style={{ display: "grid", gap: "1rem" }}>
          {result.suggestions.map((s, i) => (
            <div key={i} className="ruled" style={{ padding: "1.1rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "1rem", flexWrap: "wrap" }}>
                <h3 style={{ margin: 0 }}>{s.target.name}</h3>
                <span className="legend" style={{ color: s.tier === "warm" ? "var(--accent)" : "var(--ink-soft)" }}>
                  {s.tier === "warm" ? "WARM · you have a path" : "COLD · no warm path"} · score {s.score.total.toFixed(2)}
                </span>
              </div>

              <div className="mt"><span className="legend">Why now</span>
                <ul className="prose small" style={{ paddingLeft: "1.1rem", margin: "0.3rem 0" }}>
                  {s.whyNow.map((sig, j) => (
                    <li key={j}>{sig.detail} <span className="legend">[{sig.rung} · {sig.source?.documentName ?? "cited"}]</span>{sig.caveat ? <span className="legend"> - {sig.caveat}</span> : null}</li>
                  ))}
                </ul>
              </div>

              <div className="mt"><span className="legend">Why you</span>
                {s.warmPath ? (
                  <p className="prose small" style={{ margin: "0.3rem 0" }}>
                    {s.warmPath.hops.map((h, k) => (
                      <span key={k}>{k === 0 ? "You" : ""} <span className="legend">-{h.rel}→</span> {h.toId.replace(/^(co:|firm:|cp:)/, "")} </span>
                    ))}
                    <span className="legend">(min confidence {(s.warmPath.minConfidence * 100).toFixed(0)}%; every hop cited)</span>
                  </p>
                ) : (
                  <p className="prose small" style={{ margin: "0.3rem 0", color: "var(--ink-soft)" }}>No warm path in your network. We will not invent one.</p>
                )}
              </div>

              {s.abstentions.length > 0 && (
                <div className="mt"><span className="legend">Not established: {s.abstentions.join("; ")}</span></div>
              )}
            </div>
          ))}
        </div>

        {result.abstained.length > 0 && (
          <p className="legend mt">Abstained (no cited catalyst): {result.abstained.map((a) => a.name).join(", ")}.</p>
        )}
      </section>

      <hr className="hairline" />
      <section>
        <span className="legend"><Link href="/onboarding" style={{ color: "var(--accent)" }}>Set up your desk →</Link> · <Link href="/" style={{ color: "var(--accent)" }}>Home</Link></span>
      </section>
    </main>
  );
}
