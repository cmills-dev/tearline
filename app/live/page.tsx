// app/live/page.tsx
// LIVE Companies House data path. A document-field search box finds real companies on
// the public register; selecting one builds a partial tear sheet from the LIVE
// FactManifest and renders it through the existing SheetView / assemble pipeline.
//
// Server component: the CH_API_KEY never leaves the server. If the key is unset the
// page renders a clear inline instruction rather than crashing.

import Link from "next/link";
import { headers } from "next/headers";
import SheetView from "@/app/components/SheetView";
import {
  assembleLive,
  liveConfigured,
  searchCompanies,
} from "@/lib/sources/companiesHouseLive";
import type { CompanySearchResult } from "@/lib/sources/companiesHouse";
import type { TearSheet } from "@/lib/engine/assemble";
import type { FactManifest } from "@/lib/engine/types";
import { getTenantId } from "@/lib/tenant";
import { saveManifest, sourceKey } from "@/lib/workspace";
import { getRateLimiter, clientIp } from "@/lib/ratelimit/ratelimit";
import SignInGate from "@/app/components/SignInGate";

export const dynamic = "force-dynamic";

// Per-IP throttle on the live actions (search + build), c. 30 / minute, so one client
// cannot exhaust the instance or the shared Companies House budget. Default in-memory;
// shared across instances once the Upstash / KV env is set.
const LIVE_RATE_LIMIT = 30;
const LIVE_RATE_WINDOW = 60;

async function liveRateLimit(bucket: string): Promise<{ ok: boolean; resetSeconds: number }> {
  const ip = clientIp(await headers());
  const rl = await getRateLimiter().check(
    `live:${bucket}:${ip}`,
    LIVE_RATE_LIMIT,
    LIVE_RATE_WINDOW
  );
  return { ok: rl.ok, resetSeconds: rl.resetSeconds };
}

// Most Companies House accounts are image-only PDFs, so most figures on this page were read off
// a page image rather than a text layer. There is nothing to quote on a scan, so the banner says
// what the citation actually is: a page, the characters printed on it and a verification tag.
const BANNER =
  "LIVE Companies House data. Figures come from the accounts filing itself: filer tags where the filing is inline XBRL, otherwise the scanned pages read one by one. A figure read from a scan cites its PDF page, the label and figure exactly as printed and the scale caption, with its verification tag, rather than a quotation. Anything not printed abstains with its reason.";

function Banner() {
  return (
    <div
      style={{
        border: "1px solid var(--accent)",
        background: "rgba(122,31,43,0.06)",
        color: "var(--accent)",
        padding: "0.6rem 0.9rem",
        borderRadius: "6px",
        fontSize: "0.82rem",
        marginBottom: "1.4rem",
      }}
    >
      <strong>LIVE</strong> {BANNER.replace(/^LIVE /, "")}
    </div>
  );
}

export default async function LivePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; number?: string }>;
}) {
  const { q, number } = await searchParams;

  const tenantId = await getTenantId();
  if (!tenantId) {
    return (
      <SignInGate
        legend="Live register · Companies House"
        title="Sign in to build a sheet."
        body="A built sheet is saved to your tenant workspace, which is bound to your account."
      />
    );
  }

  // --- Key not configured: friendly inline message, no crash. ---
  if (!liveConfigured()) {
    return (
      <main className="frame doc">
        <section style={{ paddingTop: "2.2rem" }}>
          <span className="legend">Live register</span>
          <h1 style={{ marginTop: "0.5rem" }}>Companies House live data</h1>
          <Banner />
          <div className="prose">
            <p>
              The live path is not configured. Set the <code>CH_API_KEY</code>{" "}
              environment variable to a free Companies House API key, then reload this
              page.
            </p>
            <p className="small muted">
              Get a key at developer.company-information.service.gov.uk (register an
              application, then create a REST / Public Data API key). The key is used as
              the HTTP Basic username with an empty password. Until it is set, the app
              runs on the bundled illustrative fixtures.
            </p>
          </div>
        </section>
      </main>
    );
  }

  // --- A company was selected: build and render its live tear sheet. ---
  if (number) {
    let ts: TearSheet | null = null;
    let error: string | null = null;
    let toPersist: FactManifest | null = null;
    const gate = await liveRateLimit("build");
    if (!gate.ok) {
      error = `Rate limit reached. Please wait ${gate.resetSeconds}s before building another live tear sheet.`;
    } else {
      try {
        const assembled = await assembleLive(number);
        ts = assembled.ts;
        toPersist = assembled.manifest;
      } catch (err) {
        error = (err as Error).message;
      }
    }

    // Persist OUTSIDE the assembly try, fire-and-forget: a tenant-resolve or save failure must
    // never discard an already-built sheet.
    if (toPersist) {
      const manifest = toPersist;
      void Promise.resolve(saveManifest(tenantId, sourceKey("ch", manifest), manifest))
        .catch((e) => console.error("[workspace] live sheet persist failed:", (e as Error).message));
    }
    return (
      <main className="frame doc">
        <section style={{ paddingTop: "2.2rem" }}>
          <Banner />
          <p className="legend">
            <Link href={q ? `/live?q=${encodeURIComponent(q)}` : "/live"}>
              &larr; Back to search
            </Link>
          </p>
        </section>
        {error ? (
          <section>
            <div className="prose">
              <p className="muted">Could not build the live tear sheet for {number}.</p>
              <p className="small muted">{error}</p>
            </div>
          </section>
        ) : (
          ts && <SheetView ts={ts} />
        )}
      </main>
    );
  }

  // --- Default: the search view. ---
  let results: CompanySearchResult | null = null;
  let error: string | null = null;
  if (q && q.trim()) {
    const gate = await liveRateLimit("search");
    if (!gate.ok) {
      error = `Rate limit reached. Please wait ${gate.resetSeconds}s before searching again.`;
    } else {
      try {
        results = await searchCompanies(q.trim());
      } catch (err) {
        error = (err as Error).message;
      }
    }
  }

  return (
    <main className="frame doc">
      <section style={{ paddingTop: "2.2rem" }}>
        <span className="legend">Live register</span>
        <h1 style={{ marginTop: "0.5rem" }}>Companies House live data</h1>
        <Banner />
        <form method="get" action="/live" className="mt">
          <input
            type="text"
            name="q"
            defaultValue={q ?? ""}
            placeholder="Search a real company by name or number"
            aria-label="Company search"
            style={{
              width: "100%",
              padding: "0.7rem 0.9rem",
              fontSize: "1rem",
              border: "1px solid var(--rule)",
              borderRadius: "6px",
            }}
          />
          <button
            type="submit"
            style={{
              marginTop: "0.7rem",
              padding: "0.55rem 1.1rem",
              fontSize: "0.9rem",
              cursor: "pointer",
            }}
          >
            Search the register
          </button>
        </form>
      </section>

      {error && (
        <section>
          <p className="prose small muted">Search failed: {error}</p>
        </section>
      )}

      {results && (
        <section className="mt">
          <span className="legend">
            {results.total_results} match(es) on the public register
          </span>
          <div className="mt">
            {results.items.length === 0 && (
              <p className="prose small muted">No companies matched that query.</p>
            )}
            {results.items.map((item) => (
              <div className="tranche" key={item.company_number}>
                <div>
                  <div>
                    <Link
                      href={`/live?number=${encodeURIComponent(
                        item.company_number
                      )}&q=${encodeURIComponent(q ?? "")}`}
                    >
                      {item.title}
                    </Link>
                  </div>
                  <div className="meta">
                    {item.company_number} &middot; {item.company_status}
                    {item.address_snippet ? ` · ${item.address_snippet}` : ""}
                  </div>
                </div>
                <div className="amount">
                  <Link
                    className="cell-btn"
                    href={`/live?number=${encodeURIComponent(
                      item.company_number
                    )}&q=${encodeURIComponent(q ?? "")}`}
                  >
                    Build tear sheet &rarr;
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
