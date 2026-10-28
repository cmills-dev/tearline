import type { Metadata } from "next";
import "./globals.css";
import { dataMode } from "@/lib/engine/pipeline";
import DataModeChrome from "@/app/components/DataModeChrome";
import SignOutButton from "@/app/components/SignOutButton";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth/session";

// Every page renders per request, because the Content-Security-Policy nonce is per request and
// Next can only stamp it on a page it renders now (middleware.ts, lib/http/csp.ts, WP-QA05).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Tearline · verified numbers on UK private companies",
  description:
    "A name in, a decision-grade tear sheet out. Fact-manifest-first credit intelligence with cited provenance and a resolution ladder. Live Companies House, SEC and ESEF data, or labelled illustrative borrowers.",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const mode = dataMode();
  // A session cookie means the sign-out control is shown. Whether the session is still live is
  // checked where it matters (lib/tenant.ts); a stale cookie only shows a Sign out that clears it.
  const signedIn = (await cookies()).has(SESSION_COOKIE);
  return (
    <html lang="en-GB">
      <body>
        <header className="band">
          <div className="frame" style={{ padding: "0.7rem clamp(1rem,4vw,3rem)" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "0.6rem",
              }}
            >
              <a href="/" style={{ textDecoration: "none" }}>
                <span className="wordmark">Tearline</span>
              </a>
              <nav style={{ display: "flex", gap: "1rem", alignItems: "center", flexWrap: "wrap" }}>
                <a href="/onboarding" className="legend" style={{ textDecoration: "none" }}>Get set up</a>
                <a href="/pipeline" className="legend" style={{ textDecoration: "none" }}>Pipeline</a>
                <a href="/watchlist" className="legend" style={{ textDecoration: "none" }}>Watchlist</a>
                <a href="/workspace" className="legend" style={{ textDecoration: "none" }}>Workspace</a>
                <a href="/review" className="legend" style={{ textDecoration: "none" }}>Review queue</a>
                <a href="/shared-learning" className="legend" style={{ textDecoration: "none" }}>Shared learning</a>
                <a href="/kb" className="legend" style={{ textDecoration: "none" }}>Knowledge graph</a>
                {signedIn ? (
                  <SignOutButton />
                ) : (
                  <a href="/login" className="legend" style={{ textDecoration: "none" }}>Sign in</a>
                )}
                <span className="legend">Privileged &amp; Confidential · for the entitled desk only</span>
              </nav>
            </div>
          </div>
        </header>

        <DataModeChrome mode={mode}>{children}</DataModeChrome>
      </body>
    </html>
  );
}
