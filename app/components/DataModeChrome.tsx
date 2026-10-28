"use client";

// Route-aware data-mode chrome. Honesty is the product, so the banner must state each route's
// TRUE data provenance, never a blanket label:
//   - Pure live routes (/sec, /esef) always show real filed data (no key needed).
//   - CH-backed live routes (/live, /pipeline, /watchlist) show real Companies House data when
//     CH_API_KEY is set (`mode === "live"`); without a key they carry no data yet, so they say
//     "connector ready", never "synthetic".
//   - The mixed route (/originate) leads with a live panel and keeps an illustrative walkthrough
//     below, so it says both.
//   - Tenant-data routes (/workspace, /review, /housesheet, /kb) render the real entities and
//     facts the tenant has ingested, each with its own provenance, so they say "your data" and
//     defer to per-item labels, never a blanket "synthetic" stamp on real entities.
//   - Everything else (home, /sheet/*, /screen, /onboarding) is illustrative synthetic data and
//     is stamped as such.
// A false label on real data, or a "synthetic" stamp on a real-entity route, is a bug.

import { usePathname } from "next/navigation";

const bannerStyle: React.CSSProperties = {
  display: "flex",
  gap: "0.9rem",
  alignItems: "center",
  padding: "0.7rem clamp(1rem,4vw,3rem)",
  borderBottom: "1px solid var(--rule)",
  flexWrap: "wrap",
};

interface Chrome {
  stamp: string;
  live: boolean; // true => dark "LIVE" stamp; false => the illustrative stamp
  note: string;
  footer: string;
}

// A route that always shows real filed data, no key required (SEC / ESEF).
function pureLive(source: string): Chrome {
  return {
    stamp: `LIVE · ${source}`,
    live: true,
    note: "Real filed data, resolved deterministically from the tagged filing. Nothing here is synthetic.",
    footer: `This page shows live ${source}. Other routes use illustrative synthetic borrowers, labelled as such.`,
  };
}

// A Companies-House-backed route: live only when CH_API_KEY is set.
function chLiveRoute(what: string, hasKey: boolean): Chrome {
  if (hasKey) {
    return {
      stamp: `LIVE · Companies House ${what}`,
      live: true,
      // A scanned filing has no text to quote, so a figure read off a page image is cited by page,
      // printed figure and verification tag. Saying "cited" without saying that would overclaim.
      note: "Real Companies House public records. Financial lines are read from the accounts filing: filer tags where it is inline XBRL, otherwise the scanned pages, cited by page and printed figure. Anything not printed abstains with its reason.",
      footer: "This page runs on live Companies House public data. Other routes use illustrative synthetic borrowers, labelled as such.",
    };
  }
  return {
    stamp: "Connector ready · no data yet",
    live: false,
    note: "Live Companies House connector ready. Set CH_API_KEY (free) to run this route on real data. Nothing synthetic is shown in the meantime.",
    footer: "This route runs on live Companies House data once CH_API_KEY is set. It invents nothing while the key is absent.",
  };
}

// The mixed origination route: a live panel plus a clearly-labelled illustrative walkthrough.
function mixedRoute(hasKey: boolean): Chrome {
  return {
    stamp: hasKey ? "LIVE · Companies House origination" : "Connector ready · no data yet",
    live: hasKey,
    note: hasKey
      ? "The panel runs real origination on a Companies House number you enter; the walkthrough below is labelled illustrative."
      : "Set CH_API_KEY to run real origination in the panel. The walkthrough below is illustrative either way.",
    footer:
      "The live panel uses real Companies House data (with CH_API_KEY set); the walkthrough below is illustrative synthetic data, labelled as such.",
  };
}

// A tenant-data route: it renders the real entities, graph relationships and knowledge-base facts
// the tenant has already ingested, each carrying its own provenance. It must NOT be blanket-stamped
// "synthetic" (it shows real entities) nor "LIVE" (it fetches nothing itself); per-item labels
// govern, and any demo item is stamped synthetic individually.
function tenantDataRoute(what: string): Chrome {
  return {
    stamp: `Your data · ${what}`,
    live: false,
    note: "Shows the real entities and facts already in your graph and knowledge base. Each row carries its own provenance; any demo item is labelled synthetic in place.",
    footer: `This route reflects your ingested ${what}. Nothing is invented: every figure and relationship is cited, and demo items are labelled synthetic individually rather than by a blanket banner.`,
  };
}

function synthetic(): Chrome {
  return {
    stamp: "Illustrative · synthetic data",
    live: false,
    note: "Illustrative synthetic borrowers. No figure on this route describes a real entity.",
    footer:
      "Illustrative synthetic borrowers. No figure on these routes describes a real entity. Numbers are internally consistent demo data, labelled synthetic throughout.",
  };
}

function classify(pathname: string, hasKey: boolean): Chrome {
  if (pathname.startsWith("/live")) return chLiveRoute("public record", hasKey);
  if (pathname.startsWith("/pipeline")) return chLiveRoute("universe screening", hasKey);
  if (pathname.startsWith("/watchlist")) return chLiveRoute("monitoring", hasKey);
  if (pathname.startsWith("/originate")) return mixedRoute(hasKey);
  if (pathname.startsWith("/sec")) return pureLive("SEC EDGAR (US) tagged XBRL");
  if (pathname.startsWith("/esef")) return pureLive("ESEF/UKSEF iXBRL filings");
  if (pathname.startsWith("/workspace")) return tenantDataRoute("saved sheets and shortlists");
  if (pathname.startsWith("/review")) return tenantDataRoute("entity-resolution queue");
  if (pathname.startsWith("/housesheet")) return tenantDataRoute("client house sheet");
  if (pathname.startsWith("/kb")) return tenantDataRoute("knowledge-base graph");
  return synthetic();
}

export default function DataModeChrome({
  mode,
  children,
}: {
  mode: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const hasKey = mode === "live"; // dataMode() returns "live" when CH_API_KEY is present
  const c = classify(pathname, hasKey);

  return (
    <>
      <div className="frame" style={bannerStyle}>
        <span
          className="stamp"
          style={
            c.live
              ? { background: "var(--ink)", color: "var(--paper)", borderColor: "var(--ink)" }
              : undefined
          }
        >
          {c.stamp}
        </span>
        <span className="legend">{c.note}</span>
      </div>

      {children}

      <footer className="frame" style={{ padding: "2rem clamp(1rem,4vw,3rem)", borderTop: "1px solid var(--rule)" }}>
        <p className="legend">{c.footer}</p>
      </footer>
    </>
  );
}
