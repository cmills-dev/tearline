import Link from "next/link";
import { assembleEsef } from "@/lib/sources/esef";
import { getTenantId } from "@/lib/tenant";
import { saveManifest, sourceKey } from "@/lib/workspace";
import SheetView from "@/app/components/SheetView";
import SignInGate from "@/app/components/SignInGate";
import type { TearSheet } from "@/lib/engine/assemble";
import type { FactManifest } from "@/lib/engine/types";

export const dynamic = "force-dynamic";

const EXAMPLES = ["Tesco PLC", "Unilever PLC", "BP PLC", "Vodafone Group PLC"];

export default async function EsefPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const tenantId = await getTenantId();
  if (!tenantId) {
    return (
      <SignInGate
        legend="Live data · ESEF/UKSEF (Europe & UK listed)"
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
      const assembled = await assembleEsef(q.trim());
      ts = assembled?.ts ?? null;
      if (!assembled) {
        error = `No ESEF/UKSEF filing found for "${q}". Try a listed group by name or LEI.`;
      } else {
        toPersist = assembled.manifest;
      }
    } catch (e) {
      error = `ESEF lookup failed: ${(e as Error).message}`;
    }
  }

  // Persist OUTSIDE the assembly try, fire-and-forget: a tenant-resolve or save failure must never
  // discard an already-built sheet.
  if (toPersist) {
    const manifest = toPersist;
    void Promise.resolve(saveManifest(tenantId, sourceKey("esef", manifest), manifest))
      .catch((e) => console.error("[workspace] ESEF sheet persist failed:", (e as Error).message));
  }

  if (ts) {
    return (
      <>
        <div className="frame" style={{ paddingTop: "1.4rem", paddingBottom: 0 }}>
          <div className="ruled" style={{ display: "flex", justifyContent: "space-between", gap: "1rem", padding: "0.5rem 0.9rem", flexWrap: "wrap" }}>
            <span className="legend">Live ESEF/UKSEF · IFRS consolidated statements tagged in iXBRL · deterministic, no key</span>
            <span className="legend"><Link href="/esef" style={{ color: "var(--accent)" }}>New search →</Link></span>
          </div>
        </div>
        <SheetView ts={ts} />
      </>
    );
  }

  return (
    <main className="frame doc">
      <section style={{ paddingTop: "2.6rem" }}>
        <span className="legend">Live data · ESEF/UKSEF (EU + UK-listed groups)</span>
        <h1 style={{ marginTop: "0.6rem", maxWidth: "22ch" }}>A listed group in. A full, cited tear sheet out.</h1>
        <p className="prose mt">
          EU and UK-listed groups tag their IFRS consolidated statements in iXBRL with their regulator,
          even where the same company lodges only a scanned PDF at Companies House. We read the
          pre-computed facts from filings.xbrl.org, keep the consolidated totals, and resolve revenue,
          operating profit, cash and borrowings at R1, then synthesise EBITDA, net debt and leverage.
          No document parsing, no model, no fabrication. No key. Resolved to the group&rsquo;s LEI via GLEIF.
        </p>

        <form className="mt" style={{ maxWidth: "620px", display: "flex", gap: "0.6rem" }}>
          <input className="ruled" type="text" name="q" defaultValue={q ?? ""} placeholder="Listed group name or 20-char LEI" style={{ flex: 1, padding: "0.7rem 0.9rem" }} />
          <button className="ruled" type="submit" style={{ padding: "0.7rem 1.2rem", cursor: "pointer" }}>Build tear sheet</button>
        </form>
        {error && <p className="legend mt" style={{ color: "var(--accent)" }}>{error}</p>}

        <p className="legend mt">
          Examples:{" "}
          {EXAMPLES.map((t, i) => (
            <span key={t}>{i > 0 && " · "}<Link href={`/esef?q=${encodeURIComponent(t)}`} style={{ color: "var(--accent)" }}>{t}</Link></span>
          ))}
        </p>
      </section>

      <hr className="hairline" />
      <section>
        <span className="legend"><Link href="/" style={{ color: "var(--accent)" }}>← Back to the entry field</Link></span>
      </section>
    </main>
  );
}
