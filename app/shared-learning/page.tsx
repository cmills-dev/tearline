"use client";

// The shared-learning review queue (RSI Phase 2 to 3): the platform-analyst surface where
// cross-tenant synonym candidates are reviewed and, if they pass every gate, promoted into the
// shared dictionary. It shows each candidate's normalised label, the concept, how many DISTINCT
// tenants confirmed it (de-identified, a count only), and the verdict of the automated gates
// (k-anonymity, token filter, base-conflict). Promotion additionally runs an induction eval on
// the server and requires human sign-off here. Nothing client-identifying is shown, because
// nothing client-identifying is stored. See docs/rsi-feedback-design.md.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

interface Candidate {
  labelNorm: string;
  conceptKey: string;
  distinctTenants: number;
  status: string;
  promote: boolean; // the automated gates' verdict
  reasons: string[]; // why it cannot be promoted yet (empty when promote is true)
}
interface Payload {
  activeVersion: number;
  activeEntries: { labelNorm: string; conceptKey: string }[];
  candidates: Candidate[];
  adminRequired?: boolean;
}

export default function SharedLearningPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/onboarding/shared");
    const d = await r.json();
    if (r.ok) setData(d);
    else setNote(d.error ?? "Could not load the review queue.");
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function act(action: "promote" | "reject", c: Candidate) {
    setBusy(`${c.labelNorm}:${c.conceptKey}`);
    setNote(null);
    try {
      const r = await fetch("/api/onboarding/shared", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, labelNorm: c.labelNorm, conceptKey: c.conceptKey }),
      });
      const d = await r.json();
      if (!r.ok) { setNote(d.error ?? "Action failed."); return; }
      setNote(
        action === "promote"
          ? `Promoted "${c.labelNorm}" to ${c.conceptKey}. Shared dictionary is now version ${d.version}.`
          : `Rejected "${c.labelNorm}".`,
      );
      await load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="frame doc">
      <section style={{ paddingTop: "2.6rem" }}>
        <span className="legend">Shared learning · platform review · de-identified</span>
        <h1 style={{ marginTop: "0.6rem", maxWidth: "26ch" }}>Vocabulary the fleet is teaching us.</h1>
        <p className="prose mt">
          When several desks independently confirm that a label means the same concept, it becomes a
          candidate for the shared dictionary, so every client benefits. Only a normalised label, the
          concept, and a count of distinct desks are shown here. Nothing identifies a client, because
          nothing about who taught it is stored. Promotion needs k-anonymity, a clean-token check, no
          conflict with the base dictionary, an induction eval, and your sign-off.
        </p>

        {note && <p className="legend mt" style={{ color: "var(--accent)" }}>{note}</p>}
        {loading && <p className="prose mt">Loading the review queue…</p>}

        {data && (
          <>
            <p className="legend mt">
              Active shared dictionary: version {data.activeVersion} · {data.activeEntries.length} entr
              {data.activeEntries.length === 1 ? "y" : "ies"}
              {data.adminRequired ? " · promotion requires the admin secret" : ""}
            </p>

            <div className="mt" style={{ display: "grid", gap: "0.5rem" }}>
              {data.candidates.length === 0 && <p className="prose small">No candidates yet. They appear once desks resolve the same abstention.</p>}
              {data.candidates.map((c) => (
                <div key={`${c.labelNorm}:${c.conceptKey}`} className="ruled" style={{ padding: "0.8rem 1rem", display: "flex", gap: "1rem", alignItems: "center", flexWrap: "wrap", justifyContent: "space-between" }}>
                  <div>
                    <span className="prose small"><strong>{c.labelNorm}</strong> → {c.conceptKey}</span>{" "}
                    <span className="legend">· {c.distinctTenants} desk{c.distinctTenants === 1 ? "" : "s"} · {c.status}</span>
                    {c.reasons.length > 0 && (
                      <div className="legend" style={{ color: "var(--ink-soft)" }}>blocked: {c.reasons.join("; ")}</div>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <button
                      className="ruled"
                      style={{ padding: "0.35rem 0.8rem", cursor: c.promote ? "pointer" : "not-allowed", opacity: c.promote ? 1 : 0.5 }}
                      disabled={!c.promote || busy !== null || c.status === "approved"}
                      onClick={() => act("promote", c)}
                    >
                      {busy === `${c.labelNorm}:${c.conceptKey}` ? "…" : "Promote"}
                    </button>
                    <button
                      className="ruled legend"
                      style={{ padding: "0.35rem 0.7rem", cursor: "pointer" }}
                      disabled={busy !== null || c.status === "rejected"}
                      onClick={() => act("reject", c)}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <hr className="hairline" />
      <section>
        <span className="legend"><Link href="/" style={{ color: "var(--accent)" }}>← Home</Link></span>
      </section>
    </main>
  );
}
