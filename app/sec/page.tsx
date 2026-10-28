import Link from "next/link";
import { assembleEdgar } from "@/lib/sources/secEdgar";
import { getTenantId } from "@/lib/tenant";
import { saveManifest, sourceKey } from "@/lib/workspace";
import SheetView from "@/app/components/SheetView";
import SignInGate from "@/app/components/SignInGate";
import type { TearSheet } from "@/lib/engine/assemble";
import type { FactManifest } from "@/lib/engine/types";
import { notFound } from "next/navigation";
import { isHiddenRoute } from "@/lib/config/launchRoutes";

export const dynamic = "force-dynamic";

const EXAMPLES = ["AAPL", "MSFT", "KO", "F", "DE"];

export default async function SecPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  // Hidden at launch (WP-FE01, FE-09): 404 unless SHOW_NON_LAUNCH_ROUTES brings it back.
  if (isHiddenRoute("/sec")) notFound();
  const { q } = await searchParams;
  const tenantId = await getTenantId();
  if (!tenantId) {
    return (
      <SignInGate
        legend="Live data · SEC EDGAR (United States)"
        title="Sign in to build a sheet."
        body="A built sheet is saved to your tenant workspace, which is bound to your account."
      />
    );
  }

  let ts: TearSheet | null = null;
  let error: string | null = null;
  let toPersist: FactManifest | null = null;
  if (q && q.trim()) {
    try {
      const assembled = await assembleEdgar(q.trim());
      ts = assembled?.ts ?? null;
      if (!assembled) {
        error = `No SEC filer found for "${q}". Try a ticker like AAPL or a CIK.`;
      } else {
        toPersist = assembled.manifest;
      }
    } catch (e) {
      error = `SEC EDGAR request failed: ${(e as Error).message}`;
    }
  }

  // Persist OUTSIDE the assembly try, fire-and-forget: resolving the tenant or saving must never
  // discard an already-built sheet. A failure here is logged and swallowed, the render is unaffected.
  if (toPersist) {
    const manifest = toPersist;
    void Promise.resolve(saveManifest(tenantId, sourceKey("sec", manifest), manifest))
      .catch((e) => console.error("[workspace] SEC sheet persist failed:", (e as Error).message));
  }

  if (ts) {
    return (
      <>
        <div className="frame" style={{ paddingTop: "1.4rem", paddingBottom: 0 }}>
          <div
            className="ruled"
            style={{ display: "flex", justifyContent: "space-between", gap: "1rem", padding: "0.5rem 0.9rem", flexWrap: "wrap" }}
          >
            <span className="legend">
              Live SEC EDGAR · full financials tagged in XBRL · deterministic, no model
            </span>
            <span className="legend">
              <Link href="/sec" style={{ color: "var(--accent)" }}>New search →</Link>
            </span>
          </div>
        </div>
        <SheetView ts={ts} />
      </>
    );
  }

  return (
    <main className="frame doc">
      <section style={{ paddingTop: "2.6rem" }}>
        <span className="legend">Live data · SEC EDGAR (United States)</span>
        <h1 style={{ marginTop: "0.6rem", maxWidth: "20ch" }}>A US ticker in. A full, cited tear sheet out.</h1>
        <p className="prose mt">
          US filers tag their income statement, balance sheet and cash flow in full, so the sheet
          resolves deterministically from the SEC&rsquo;s own Company Facts XBRL. Turnover, operating
          profit, depreciation, cash and debt come back reported at R1, and the resolution ladder
          synthesises EBITDA, net debt, leverage and interest cover. No document parsing, no model, so
          no figure is fabricated. No key required.
        </p>

        <form className="mt" style={{ maxWidth: "620px", display: "flex", gap: "0.6rem" }}>
          <input
            className="ruled"
            type="text"
            name="q"
            defaultValue={q ?? ""}
            placeholder="Ticker (AAPL) or CIK"
            style={{ flex: 1, padding: "0.7rem 0.9rem" }}
          />
          <button className="ruled" type="submit" style={{ padding: "0.7rem 1.2rem", cursor: "pointer" }}>
            Build tear sheet
          </button>
        </form>
        {error && <p className="legend mt" style={{ color: "var(--accent)" }}>{error}</p>}

        <p className="legend mt">
          Examples:{" "}
          {EXAMPLES.map((t, i) => (
            <span key={t}>
              {i > 0 && " · "}
              <Link href={`/sec?q=${t}`} style={{ color: "var(--accent)" }}>{t}</Link>
            </span>
          ))}
        </p>
      </section>

      <hr className="hairline" />
      <section>
        <span className="legend">
          <Link href="/" style={{ color: "var(--accent)" }}>← Back to the entry field</Link>
        </span>
      </section>
    </main>
  );
}
