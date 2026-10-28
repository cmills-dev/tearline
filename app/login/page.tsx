"use client";

// Sign-in and registration. One form, a toggle between the two modes. On success the auth
// route sets the session cookie, so we return to the page that was asked for. Copy is kept
// understated: this is a document surface, not a marketing page.

import { useEffect, useState } from "react";
import Link from "next/link";
import { safeReturnPath } from "@/lib/config/launchRoutes";

type Mode = "login" | "register";

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The invite link is /login?invite=<token> (lib/auth/invite.ts). Registration is invite-only
  // in production, so the token must travel with the register call, and the link should open
  // on the register form. Read on mount, not with useSearchParams, so the page stays static.
  const [invite, setInvite] = useState<string | null>(null);
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("invite");
    if (token) {
      setInvite(token);
      setMode("register");
    }
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "register" && invite ? { email, password, invite } : { email, password }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Something went wrong. Try again.");
        setBusy(false);
        return;
      }
      // Back to the page the sign-in gate intercepted (the middleware passes it as ?next=), or the
      // run entry. safeReturnPath keeps only a same-origin path. The old landings (/onboarding,
      // /originate) are hidden at launch, so they are no longer the default.
      window.location.href = safeReturnPath(new URLSearchParams(window.location.search).get("next"));
    } catch {
      setError("Network error. Try again.");
      setBusy(false);
    }
  }

  const isRegister = mode === "register";

  return (
    <main className="frame doc">
      <section style={{ paddingTop: "2.2rem", maxWidth: "440px" }}>
        <span className="legend">
          {isRegister ? "Register · a private desk of your own" : "Sign in · resume your desk"}
        </span>
        <h1 style={{ marginTop: "0.6rem" }}>
          {isRegister ? "Create your account." : "Welcome back."}
        </h1>
        <p className="prose mt">
          {isRegister
            ? "Registration opens a tenant that is yours alone. Everything you save, and every relationship you seed, stays inside it, enforced in the database and never shared across desks."
            : "Sign in to return to your tenant. Your records and relationship graph are exactly as you left them."}
        </p>

        <form onSubmit={submit} className="mt" style={{ display: "flex", flexDirection: "column", gap: "0.8rem" }}>
          <label className="legend" htmlFor="email" style={{ display: "block" }}>
            Email
          </label>
          <input
            id="email"
            className="ruled"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={{ padding: "0.7rem 0.9rem", width: "100%" }}
          />

          <label className="legend" htmlFor="password" style={{ display: "block", marginTop: "0.4rem" }}>
            Password
          </label>
          <input
            id="password"
            className="ruled"
            type="password"
            autoComplete={isRegister ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={isRegister ? 8 : undefined}
            style={{ padding: "0.7rem 0.9rem", width: "100%" }}
          />
          {isRegister && (
            <span className="legend" style={{ color: "var(--ink-soft)" }}>
              c. eight characters minimum.
            </span>
          )}

          {error && (
            <p className="prose small" style={{ color: "var(--accent)", margin: "0.2rem 0 0" }}>
              {error}
            </p>
          )}

          <button
            type="submit"
            className="ruled"
            disabled={busy}
            style={{ padding: "0.8rem 1.2rem", marginTop: "0.6rem", cursor: "pointer", background: "var(--cover)", color: "#e8e4db", borderColor: "var(--cover)", textTransform: "uppercase", letterSpacing: "0.14em", fontSize: "0.72rem" }}
          >
            {busy ? "…" : isRegister ? "Create account" : "Sign in"}
          </button>
        </form>

        <p className="legend mt">
          {isRegister ? "Already have a desk? " : "No account yet? "}
          <button
            type="button"
            onClick={() => {
              setMode(isRegister ? "login" : "register");
              setError(null);
            }}
            className="cell-btn"
            style={{ color: "var(--accent)", letterSpacing: "0.18em", textTransform: "uppercase", fontSize: "0.68rem" }}
          >
            {isRegister ? "Sign in" : "Register"}
          </button>
        </p>
      </section>

      <hr className="hairline" />
      <section>
        <span className="legend">
          <Link href="/" style={{ color: "var(--accent)" }}>
            ← Back to the entry field
          </Link>
        </span>
      </section>
    </main>
  );
}
