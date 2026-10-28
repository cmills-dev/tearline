"use client";

// app/components/SignOutButton.tsx
// The header's sign-out control (WP-FE01, FE-07 part). It posts to /api/auth/logout, which
// revokes the server-side session row and clears both session cookies, then lands on /login.
// A failed call is said out loud rather than pretending the session ended.

import { useState } from "react";

export default function SignOutButton() {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signOut() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch("/api/auth/logout", { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      window.location.href = "/login";
    } catch {
      setFailed(true);
      setBusy(false);
    }
  }

  return (
    <button type="button" className="legend cell-btn" onClick={signOut} disabled={busy} style={{ textDecoration: "none" }}>
      {busy ? "Signing out…" : failed ? "Sign out failed. Try again" : "Sign out"}
    </button>
  );
}
