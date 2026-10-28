"use client";

// Conversational onboarding (the assistant variant). Kept as an alternate to the structured
// wizard at /onboarding: the AI asks questions, learns the firm's mandate and who they know
// (PE sponsors, law firms, lenders, advisers), confirms each captured fact, and seeds the
// private relationship graph. Everything captured is echoed back; nothing is invented. Needs
// an LLM configured; the structured wizard needs no key, so it is the default front door.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

interface Msg { role: "ai" | "you"; text: string }
interface Profile {
  firmName?: string;
  mandate: { sectors?: string[]; minTurnover?: number; maxTurnover?: number };
  relationships: { counterpartyName: string; counterpartyType: string; strength: number }[];
  constraints: string[];
  confirmed: boolean;
}

const empty: Profile = { mandate: {}, relationships: [], constraints: [], confirmed: false };

export default function AssistantOnboardingPage() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [profile, setProfile] = useState<Profile>(empty);
  const [input, setInput] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/onboarding")
      .then((r) => r.json())
      .then((d) => setMessages([{ role: "ai", text: d.opening ?? "Tell me about your desk to get started." }]))
      .catch(() => setMessages([{ role: "ai", text: "Could not reach the assistant. Reload to try again." }]));
  }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || busy || done) return;
    setInput("");
    setMessages((m) => [...m, { role: "you", text }]);
    setBusy(true);
    // A failed turn (network drop, 4xx/5xx, malformed body) must never wedge the input or clobber
    // the profile with undefined: catch it, show an honest retry line, and always release busy.
    try {
      const res = await fetch("/api/onboarding", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile, userText: text }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d.error) {
        setMessages((m) => [...m, { role: "ai", text: d.error ?? "Something went wrong on that turn. Your progress is kept, please try again." }]);
        return;
      }
      setProfile(d.profile);
      setDone(d.done);
      setMessages((m) => [...m, { role: "ai", text: [d.confirmation, d.nextQuestion].filter(Boolean).join(" ") }]);
    } catch {
      setMessages((m) => [...m, { role: "ai", text: "The connection dropped on that turn. Your progress is kept, please try again." }]);
    } finally {
      setBusy(false);
    }
  }

  const fmt = (n?: number) => (n === undefined ? "" : `£${(n / 1e6).toFixed(0)}m`);

  return (
    <main className="frame doc">
      <section style={{ paddingTop: "2.2rem" }}>
        <span className="legend">Conversational setup · your desk, learned in a conversation</span>
        <h1 style={{ marginTop: "0.6rem", maxWidth: "22ch" }}>Tell us your mandate and who you know.</h1>
        <p className="prose mt">
          The assistant asks a few questions and builds your workspace: what you invest in, and the
          people who help you win work (PE sponsors, law firms, lenders, advisers). Everything it captures
          is shown back for you to confirm, kept private to your desk, and never resold. It drives your
          origination shortlist. Prefer a structured form?{" "}
          <Link href="/onboarding" style={{ color: "var(--accent)" }}>Use the setup wizard →</Link>
        </p>

        <div className="mt" style={{ display: "grid", gridTemplateColumns: "1fr 260px", gap: "1.5rem", alignItems: "start" }}>
          <div>
            <div className="ruled" style={{ padding: "1rem", minHeight: "320px", maxHeight: "52vh", overflowY: "auto" }}>
              {messages.map((m, i) => (
                <div key={i} style={{ margin: "0.6rem 0", textAlign: m.role === "you" ? "right" : "left" }}>
                  <span className="legend" style={{ display: "block", color: m.role === "ai" ? "var(--accent)" : "var(--ink-soft)" }}>{m.role === "ai" ? "Assistant" : "You"}</span>
                  <span className="prose small" style={{ display: "inline-block", maxWidth: "80%" }}>{m.text}</span>
                </div>
              ))}
              <div ref={endRef} />
            </div>
            {!done ? (
              <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.6rem" }}>
                <input className="ruled" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder="Type your answer…" style={{ flex: 1, padding: "0.7rem 0.9rem" }} disabled={busy} />
                <button className="ruled" onClick={send} disabled={busy} style={{ padding: "0.7rem 1.2rem", cursor: "pointer" }}>{busy ? "…" : "Send"}</button>
              </div>
            ) : (
              <p className="legend mt" style={{ color: "var(--accent)" }}>Setup complete. <Link href="/originate">See your origination shortlist →</Link></p>
            )}
          </div>

          <aside className="ruled" style={{ padding: "1rem" }}>
            <span className="legend">Captured profile</span>
            <div className="prose small mt">
              <div><strong>Firm:</strong> {profile.firmName || "not set"}</div>
              <div className="mt"><strong>Sectors:</strong> {profile.mandate.sectors?.join(", ") || "not set"}</div>
              <div><strong>Size:</strong> {profile.mandate.minTurnover || profile.mandate.maxTurnover ? `${fmt(profile.mandate.minTurnover) || "any"} to ${fmt(profile.mandate.maxTurnover) || "any"}` : "not set"}</div>
              <div className="mt"><strong>Network ({profile.relationships.length}):</strong></div>
              <ul style={{ paddingLeft: "1rem", margin: "0.3rem 0" }}>
                {profile.relationships.map((r, i) => (<li key={i}>{r.counterpartyName} <span className="legend">({r.counterpartyType}, {r.strength}/5)</span></li>))}
              </ul>
              {profile.constraints.length > 0 && <div className="mt"><strong>No-go:</strong> {profile.constraints.join(", ")}</div>}
            </div>
          </aside>
        </div>
      </section>

      <hr className="hairline" />
      <section><span className="legend"><Link href="/" style={{ color: "var(--accent)" }}>← Back to the entry field</Link></span></section>
    </main>
  );
}
