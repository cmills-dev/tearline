// app/pipeline/page.tsx
// Engine C surface, universe-wide. Where /originate scores one Companies House number, this
// screens a whole mandate universe: enter a mandate (sectors/SIC, size band, max leverage)
// plus optional filters, and the pipeline returns a ranked, evidence-backed origination list.
// A candidate with no cited catalyst is abstained and reported as a count, never surfaced with
// an invented reason. Server-rendered shell; the screening runs through a client panel.

import Link from "next/link";
import { getTenantId } from "@/lib/tenant";
import PipelinePanel from "./PipelinePanel";
import { notFound } from "next/navigation";
import { isHiddenRoute } from "@/lib/config/launchRoutes";

export const dynamic = "force-dynamic";

const CH_CONFIGURED = !!process.env.CH_API_KEY;

export default async function PipelinePage() {
  // Hidden at launch (WP-FE01, FE-09): 404 unless SHOW_NON_LAUNCH_ROUTES brings it back.
  if (isHiddenRoute("/pipeline")) notFound();
  // Resolve the tenant server-side so the shell can note an enforced-auth deployment honestly.
  const tenantId = await getTenantId();

  return (
    <main className="frame doc">
      <section style={{ paddingTop: "2.2rem" }}>
        <span className="legend">Engine C · continuous universe screening · live</span>
        <h1 style={{ marginTop: "0.6rem", maxWidth: "26ch" }}>Screen a whole universe, not one name.</h1>
        <p className="prose mt">
          Enter a mandate and, optionally, universe filters. We build a candidate pool from the
          Companies House register, run the same document-cited origination over each member, and
          return a ranked list. Each surfaced target carries a <strong>why now</strong> (a cited
          catalyst) and a <strong>why you</strong> (a provenanced warm path). Members with no cited
          catalyst are abstained and reported as a count, never surfaced by a guess. We process up
          to a fixed cap per sweep and say plainly how many candidates were left unscreened.
          {CH_CONFIGURED
            ? ""
            : " The pipeline needs CH_API_KEY (free from Companies House); without it it returns an honest note and no candidates."}
        </p>
        {!tenantId && (
          <p className="legend mt" style={{ color: "var(--accent)" }}>
            This deployment enforces authentication. Sign in to screen a universe.
          </p>
        )}
        <PipelinePanel />
      </section>

      <hr className="hairline" />
      <section>
        <span className="legend">
          <Link href="/originate" style={{ color: "var(--accent)" }}>Originate one target →</Link> ·{" "}
          <Link href="/" style={{ color: "var(--accent)" }}>Home</Link>
        </span>
      </section>
    </main>
  );
}
