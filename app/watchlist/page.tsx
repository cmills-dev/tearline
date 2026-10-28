// app/watchlist/page.tsx
// The tenant's change-detection watchlist: the companies this desk watches and the recent
// cited change events. Server-rendered from the tenant-scoped monitor store, with a small
// client control (WatchlistPanel) to add/remove a company and to trigger a re-check. Every
// event is shown with its provenance, so the page never states a change it did not observe.

import Link from "next/link";
import { getTenantId } from "@/lib/tenant";
import { getMonitorStore } from "@/lib/monitor/store";
import WatchlistPanel from "./WatchlistPanel";
import { notFound } from "next/navigation";
import { isHiddenRoute } from "@/lib/config/launchRoutes";

export const dynamic = "force-dynamic";

export default async function WatchlistPage() {
  // Hidden at launch (WP-FE01, FE-09): 404 unless SHOW_NON_LAUNCH_ROUTES brings it back.
  if (isHiddenRoute("/watchlist")) notFound();
  const tenantId = await getTenantId();
  if (!tenantId) {
    return (
      <main className="frame doc">
        <section style={{ paddingTop: "2.6rem" }}>
          <span className="legend">Monitoring · tenant-scoped</span>
          <h1 style={{ marginTop: "0.6rem" }}>Sign in to watch companies.</h1>
          <p className="prose mt">
            The watchlist is bound to your tenant. <Link href="/login" style={{ color: "var(--accent)" }}>Sign in →</Link>
          </p>
        </section>
      </main>
    );
  }

  const store = getMonitorStore();
  const [watchlist, events] = await Promise.all([
    store.listWatchlist(tenantId),
    store.listEvents(tenantId, 50),
  ]);
  const live = Boolean(process.env.CH_API_KEY);

  return (
    <main className="frame doc">
      <section style={{ paddingTop: "2.6rem" }}>
        <span className="legend">Monitoring · tenant-scoped</span>
        <h1 style={{ marginTop: "0.6rem", maxWidth: "22ch" }}>
          The companies you watch, and what changed.
        </h1>
        <p className="prose mt">
          Add a company by its Companies House number. Each re-check snapshots the public register,
          then diffs the fresh state against the last snapshot and records only the movements it
          actually observes, a new charge, a satisfied charge, a person with significant control
          added or ceased, a status change, or accounts or a confirmation statement newly overdue.
          Every event carries its source. {live
            ? "Live data is configured, so a re-check reads the register now."
            : "Live data is not configured; set CH_API_KEY (free from Companies House) to run a re-check."}
        </p>

        <WatchlistPanel initialWatchlist={watchlist} initialEvents={events} />
      </section>

      <hr className="hairline" />

      <section>
        <span className="legend">
          <Link href="/workspace" style={{ color: "var(--accent)" }}>← Your workspace</Link>
        </span>
      </section>
    </main>
  );
}
