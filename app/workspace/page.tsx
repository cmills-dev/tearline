import Link from "next/link";
import { getTenantId } from "@/lib/tenant";
import { listWorkspace, listSuggestions, storeIsDurable } from "@/lib/workspace";
import SignInGate from "@/app/components/SignInGate";

export const dynamic = "force-dynamic";

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default async function WorkspacePage() {
  const tenantId = await getTenantId();
  if (!tenantId) {
    return (
      <SignInGate
        legend="Your workspace · tenant-scoped"
        title="Sign in to see your workspace."
        body="Every sheet and shortlist you save is bound to your tenant and invisible to any other."
      />
    );
  }
  const refs = await listWorkspace(tenantId);
  const shortlists = await listSuggestions(tenantId);
  const durable = storeIsDurable();

  return (
    <main className="frame doc">
      <section style={{ paddingTop: "2.6rem" }}>
        <span className="legend">Your workspace · tenant-scoped</span>
        <h1 style={{ marginTop: "0.6rem", maxWidth: "20ch" }}>The tear sheets you have opened.</h1>
        <p className="prose mt">
          Every sheet you open is saved to your own workspace, keyed to this browser and invisible to
          any other tenant. {durable
            ? "Storage is durable: these records survive a restart."
            : "Storage is in-memory for this session; set DATABASE_URL (Postgres) to make it durable."}
        </p>

        <div className="mt">
          {refs.length === 0 ? (
            <p className="legend">
              Nothing saved yet. <Link href="/" style={{ color: "var(--accent)" }}>Open a tear sheet →</Link>
            </p>
          ) : (
            <div className="card-grid">
              {refs.map((r) => (
                <Link
                  key={r.key}
                  href={`/sheet/${r.key}`}
                  className="ruled"
                  style={{ display: "block", padding: "1.2rem", textDecoration: "none" }}
                >
                  <span className="legend">
                    {r.synthetic ? "Illustrative · synthetic" : "Real entity"} · saved {when(r.savedAt)}
                  </span>
                  <h3 style={{ marginTop: "0.5rem" }}>{r.companyName}</h3>
                  <span className="legend" style={{ color: "var(--accent)" }}>Reopen →</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </section>

      <hr className="hairline" />

      <section>
        <span className="legend">Origination shortlists · tenant-scoped</span>
        <h2 style={{ marginTop: "0.6rem" }}>Targets you have saved.</h2>
        <p className="prose mt">
          Suggestions saved from the live origination panel, each with its cited why-now, its warm
          path (or an honest cold marker) and its score.
          {durable
            ? ""
            : " Shortlists are held in memory for this session; a durable table is a follow-up."}
        </p>

        <div className="mt">
          {shortlists.length === 0 ? (
            <p className="legend">
              No shortlists yet.{" "}
              <Link href="/originate" style={{ color: "var(--accent)" }}>Originate for a real target →</Link>
            </p>
          ) : (
            <div className="card-grid">
              {shortlists.map((s, i) => (
                <div key={i} className="ruled" style={{ display: "block", padding: "1.2rem" }}>
                  <span className="legend">
                    {s.tier === "warm" ? "WARM · path found" : "COLD · no warm path"} · score{" "}
                    {s.score.total.toFixed(2)} · saved {when(s.savedAt)}
                  </span>
                  <h3 style={{ marginTop: "0.5rem" }}>{s.target.name}</h3>
                  {s.target.chNumber && <span className="legend">Companies House {s.target.chNumber}</span>}
                  <ul className="prose small" style={{ paddingLeft: "1.1rem", margin: "0.5rem 0 0" }}>
                    {s.whyNow.slice(0, 3).map((sig, j) => (
                      <li key={j}>
                        {sig.detail} <span className="legend">[{sig.rung}]</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
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
