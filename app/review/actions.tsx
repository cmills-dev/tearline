"use client";

// The confirm/reject/merge controls for the entity-resolution review queue. Each button posts one
// action to /api/resolve and, on success, refreshes the server-rendered page so the queue reflects
// the new state. Nothing is decided here that a human did not click.

import { useState } from "react";
import { useRouter } from "next/navigation";

type Action =
  | { action: "confirm-lei"; nodeId: string; lei: string; confidence: number }
  | { action: "reject-lei"; nodeId: string }
  | { action: "merge"; keepId: string; dropId: string }
  | { action: "run" };

export function ReviewButton({
  payload,
  children,
  variant = "plain",
}: {
  payload: Action;
  children: React.ReactNode;
  variant?: "plain" | "accent";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(typeof data.error === "string" ? data.error : "Request failed.");
        setBusy(false);
        return;
      }
      router.refresh();
    } catch {
      setErr("Network error.");
      setBusy(false);
    }
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
      <button
        className="export-btn"
        onClick={go}
        disabled={busy}
        style={variant === "accent" ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}
      >
        {busy ? "…" : children}
      </button>
      {err && <span className="legend" style={{ color: "var(--accent)" }}>{err}</span>}
    </span>
  );
}
