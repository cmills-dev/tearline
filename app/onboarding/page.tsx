"use client";

// The "get set up" wizard: a seamless, four-step client onboarding that needs no keys to run
// end to end. Step 1 captures the desk and mandate; step 2 seeds the private relationship
// network; step 3 INGESTS an example tear sheet and induces the client's house-sheet spec
// (fields, labels, style, honest abstentions on anything it cannot map); step 4 reviews and
// activates it, after which every sheet renders in the client's own house style. Progress is
// tenant-scoped and resumable. Nothing is invented: an unmapped field is surfaced for the
// analyst, never guessed. Prefer a conversation? The assistant variant lives at
// /onboarding/assistant.

import { useEffect, useState } from "react";
import Link from "next/link";

// ---- Minimal client-side shapes (mirrors lib/clientspec, kept local so this stays a pure
// client component with no server imports) --------------------------------------------------
type Rung = "R1" | "R2" | "R3" | "R4";
interface SpecField {
  key: string;
  label: string;
  ontologyConcept: string;
  required: boolean;
  resolutionFloor?: Rung;
  format?: string;
}
interface StyleTokens { voice: string; numberStyle: string; dateFormat: string; currencyDefault: string }
interface ClientSpec {
  contractVersion: string; clientId: string; version: number; name: string;
  fields: SpecField[]; styleTokens: StyleTokens; skeleton: string[]; inducedFrom: string[]; createdAt: string;
}
interface Induced { spec: ClientSpec; unmapped: string[]; mappedCount: number }
interface Relationship { counterpartyName: string; counterpartyType: string; relationship: string; strength: number }

const STEPS = ["Desk & mandate", "Network", "House sheet", "Review & activate"] as const;
const CP_TYPES = ["pe", "law", "lender", "bank", "adviser", "accountant", "company"];
const REL_KINDS = ["know", "worked_with", "introduced_by", "co_invested"];

// The engine concepts a client can bind an abstained line to (RSI Phase 1). Keys match
// lib/clientspec/concepts.ts. Teaching one here persists a per-client synonym, so the same
// label maps automatically next time.
const CONCEPT_OPTIONS: { key: string; label: string }[] = [
  { key: "turnover", label: "Turnover / revenue" },
  { key: "grossProfit", label: "Gross profit" },
  { key: "operatingProfit", label: "Operating profit" },
  { key: "ebitda", label: "EBITDA" },
  { key: "netDebt", label: "Net debt" },
  { key: "borrowings", label: "Total borrowings" },
  { key: "cash", label: "Cash" },
  { key: "leverage", label: "Net leverage" },
  { key: "interestCover", label: "Interest cover" },
  { key: "netCurrentAssets", label: "Net current assets" },
  { key: "netAssets", label: "Net assets" },
  { key: "totalAssets", label: "Total assets" },
  { key: "equity", label: "Equity" },
  { key: "sector", label: "Sector" },
];

const SAMPLE_SHEET = [
  "ACME CREDIT HOUSE SHEET",
  "",
  "FINANCIALS",
  "Turnover                        £152,300",
  "Adjusted EBITDA                  £28,400",
  "Operating profit                 £24,900",
  "",
  "LEVERAGE & LIQUIDITY",
  "Net debt                         £86,000",
  "Net leverage                      3.0x",
  "Interest cover                    6.1x",
  "Cash and cash equivalents        £12,500",
  "",
  "BALANCE SHEET",
  "Net assets                       £44,200",
  "",
  "Management commentary score        7.5",
].join("\n");

export default function OnboardingWizard() {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // Step 1: desk & mandate
  const [firmName, setFirmName] = useState("");
  const [sectors, setSectors] = useState("");
  const [minTurnover, setMinTurnover] = useState("");
  const [maxTurnover, setMaxTurnover] = useState("");
  const [maxLeverage, setMaxLeverage] = useState("");

  // Step 2: network
  const [rels, setRels] = useState<Relationship[]>([]);
  const [rName, setRName] = useState("");
  const [rType, setRType] = useState("law");
  const [rRel, setRRel] = useState("know");
  const [rStrength, setRStrength] = useState(3);

  // Step 3: house sheet
  const [exampleName, setExampleName] = useState("");
  const [exampleText, setExampleText] = useState("");
  const [induced, setInduced] = useState<Induced | null>(null);
  const [resolveChoice, setResolveChoice] = useState<Record<string, string>>({}); // unmapped label -> chosen concept

  // Step 4: activation
  const [activated, setActivated] = useState<{ version: number } | null>(null);

  // Resume progress on mount.
  useEffect(() => {
    fetch("/api/onboarding/state")
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (s?.firmName) setFirmName(s.firmName);
        const m = s?.mandate;
        if (m) {
          if (Array.isArray(m.sectors)) setSectors(m.sectors.join(", "));
          if (typeof m.minTurnover === "number") setMinTurnover(String(m.minTurnover / 1_000_000));
          if (typeof m.maxTurnover === "number") setMaxTurnover(String(m.maxTurnover / 1_000_000));
          if (typeof m.maxLeverage === "number") setMaxLeverage(String(m.maxLeverage));
        }
        if (s?.complete) setNote("You have already completed setup. You can re-run any step to update it.");
      })
      .catch(() => {});
  }, []);

  async function saveDesk() {
    setBusy(true);
    try {
      // Build the mandate from the step-1 inputs. Turnover is entered in millions and stored in
      // absolute currency (x1e6) to match MandateLike, so origination fit-scoring reads it directly.
      const toAbs = (s: string) => {
        const n = Number(s.trim());
        return s.trim() && Number.isFinite(n) && n >= 0 ? n * 1_000_000 : undefined;
      };
      const lev = Number(maxLeverage.trim());
      const mandate = {
        sectors: sectors.split(",").map((x) => x.trim()).filter(Boolean),
        minTurnover: toAbs(minTurnover),
        maxTurnover: toAbs(maxTurnover),
        maxLeverage: maxLeverage.trim() && Number.isFinite(lev) && lev >= 0 ? lev : undefined,
      };
      await fetch("/api/onboarding/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: "desk", firmName: firmName.trim() || undefined, mandate }),
      });
      setStep(1);
    } finally {
      setBusy(false);
    }
  }

  function addRel() {
    if (!rName.trim()) return;
    setRels((rs) => [...rs, { counterpartyName: rName.trim(), counterpartyType: rType, relationship: rRel, strength: rStrength }]);
    setRName("");
  }

  async function seedNetwork() {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/onboarding/network", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ firmName: firmName.trim() || undefined, relationships: rels }),
      });
      const d = await res.json();
      setNote(`Seeded ${d.seeded ?? 0} relationship${(d.seeded ?? 0) === 1 ? "" : "s"} into your private network.`);
      setStep(2);
    } finally {
      setBusy(false);
    }
  }

  async function induce() {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/onboarding/clientspec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: exampleText, name: exampleName.trim() || undefined }),
      });
      const d = await res.json();
      if (!res.ok) { setNote(d.error ?? "Could not read that sheet."); return; }
      setInduced(d.induced as Induced);
    } finally {
      setBusy(false);
    }
  }

  function editField(i: number, patch: Partial<SpecField>) {
    setInduced((cur) => {
      if (!cur) return cur;
      const fields = cur.spec.fields.map((f, j) => (j === i ? { ...f, ...patch } : f));
      return { ...cur, spec: { ...cur.spec, fields } };
    });
  }

  // RSI Phase 1: teach the system that an abstained line means a concept. Persists a per-client
  // synonym, then folds the line into the mapped fields and drops it from the unmapped list.
  async function resolveAbstention(label: string, conceptKey: string) {
    if (!conceptKey) return;
    const res = await fetch("/api/onboarding/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resolve", label, conceptKey }),
    });
    const d = await res.json();
    if (!res.ok || !d.field) { setNote(d.error ?? "Could not save that mapping."); return; }
    setInduced((cur) => {
      if (!cur) return cur;
      const fields = cur.spec.fields.some((f) => f.key === d.field.key)
        ? cur.spec.fields // concept already present; just clear the abstention
        : [...cur.spec.fields, d.field];
      return { ...cur, spec: { ...cur.spec, fields }, unmapped: cur.unmapped.filter((u) => u !== label), mappedCount: fields.length };
    });
    setNote(`Learned: "${label}" now maps to ${conceptKey} for your desk.`);
  }

  async function dismissAbstention(label: string) {
    await fetch("/api/onboarding/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "dismiss", label }),
    });
    setInduced((cur) => (cur ? { ...cur, unmapped: cur.unmapped.filter((u) => u !== label) } : cur));
  }

  async function activate() {
    if (!induced) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/onboarding/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec: induced.spec }),
      });
      const d = await res.json();
      if (!res.ok) { setNote(d.error ?? "Could not activate the spec."); return; }
      setActivated({ version: d.version });
    } finally {
      setBusy(false);
    }
  }

  const inputStyle: React.CSSProperties = { width: "100%", padding: "0.6rem 0.8rem", marginTop: "0.3rem" };

  return (
    <main className="frame doc">
      <section style={{ paddingTop: "2.2rem" }}>
        <span className="legend">Get set up · a new client, onboarded end to end</span>
        <h1 style={{ marginTop: "0.6rem", maxWidth: "24ch" }}>Set up your desk and your house sheet.</h1>
        <p className="prose mt">
          Four steps: tell us your mandate, seed the people you know, hand us one example of your
          house tear sheet, and confirm. From then on, every sheet renders in your own style, with
          your fields and your labels. Anything we cannot map from your example is shown to you for
          review, never guessed. Prefer to talk it through?{" "}
          <Link href="/onboarding/assistant" style={{ color: "var(--accent)" }}>Use the assistant →</Link>
        </p>

        {/* Stepper */}
        <div className="mt" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          {STEPS.map((s, i) => (
            <span
              key={s}
              className="stamp"
              style={
                i === step
                  ? { background: "var(--ink)", color: "var(--paper)", borderColor: "var(--ink)" }
                  : i < step
                    ? { borderColor: "var(--ink-soft)", color: "var(--ink-soft)" }
                    : undefined
              }
            >
              {i + 1}. {s}
            </span>
          ))}
        </div>

        {note && <p className="legend mt" style={{ color: "var(--accent)" }}>{note}</p>}

        {/* Step 1: Desk & mandate */}
        {step === 0 && (
          <div className="ruled mt" style={{ padding: "1.2rem", maxWidth: "620px" }}>
            <span className="legend">Step 1 · your desk and mandate</span>
            <div className="mt">
              <label className="prose small">Firm name
                <input className="ruled" style={inputStyle} value={firmName} onChange={(e) => setFirmName(e.target.value)} placeholder="e.g. Acme Credit Partners" />
              </label>
            </div>
            <div className="mt">
              <label className="prose small">Sectors (comma separated)
                <input className="ruled" style={inputStyle} value={sectors} onChange={(e) => setSectors(e.target.value)} placeholder="business services, healthcare, software" />
              </label>
            </div>
            <div className="mt" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.8rem" }}>
              <label className="prose small">Min turnover (£m)
                <input className="ruled" style={inputStyle} value={minTurnover} onChange={(e) => setMinTurnover(e.target.value)} placeholder="20" inputMode="numeric" />
              </label>
              <label className="prose small">Max turnover (£m)
                <input className="ruled" style={inputStyle} value={maxTurnover} onChange={(e) => setMaxTurnover(e.target.value)} placeholder="500" inputMode="numeric" />
              </label>
              <label className="prose small">Max leverage (x)
                <input className="ruled" style={inputStyle} value={maxLeverage} onChange={(e) => setMaxLeverage(e.target.value)} placeholder="6" inputMode="numeric" />
              </label>
            </div>
            <div className="mt" style={{ display: "flex", gap: "0.6rem" }}>
              <button className="ruled" onClick={saveDesk} disabled={busy} style={{ padding: "0.6rem 1.2rem", cursor: "pointer" }}>{busy ? "…" : "Save & continue →"}</button>
            </div>
          </div>
        )}

        {/* Step 2: Network */}
        {step === 1 && (
          <div className="ruled mt" style={{ padding: "1.2rem", maxWidth: "720px" }}>
            <span className="legend">Step 2 · who you know (seeds your private warm-path network)</span>
            <div className="mt" style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 0.7fr auto", gap: "0.5rem", alignItems: "end" }}>
              <label className="prose small">Counterparty
                <input className="ruled" style={inputStyle} value={rName} onChange={(e) => setRName(e.target.value)} placeholder="e.g. Kirkland & Ellis" onKeyDown={(e) => e.key === "Enter" && addRel()} />
              </label>
              <label className="prose small">Type
                <select className="ruled" style={inputStyle} value={rType} onChange={(e) => setRType(e.target.value)}>{CP_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select>
              </label>
              <label className="prose small">Relationship
                <select className="ruled" style={inputStyle} value={rRel} onChange={(e) => setRRel(e.target.value)}>{REL_KINDS.map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}</select>
              </label>
              <label className="prose small">Strength
                <select className="ruled" style={inputStyle} value={rStrength} onChange={(e) => setRStrength(Number(e.target.value))}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select>
              </label>
              <button className="ruled" onClick={addRel} style={{ padding: "0.6rem 1rem", cursor: "pointer" }}>Add</button>
            </div>

            {rels.length > 0 && (
              <ul className="prose small mt" style={{ paddingLeft: "1.1rem" }}>
                {rels.map((r, i) => (
                  <li key={i}>{r.counterpartyName} <span className="legend">({r.counterpartyType} · {r.relationship.replace("_", " ")} · {r.strength}/5)</span></li>
                ))}
              </ul>
            )}

            <div className="mt" style={{ display: "flex", gap: "0.6rem" }}>
              <button className="ruled" onClick={seedNetwork} disabled={busy} style={{ padding: "0.6rem 1.2rem", cursor: "pointer" }}>{busy ? "…" : "Seed network & continue →"}</button>
              <button className="ruled" onClick={() => setStep(2)} disabled={busy} style={{ padding: "0.6rem 1.2rem", cursor: "pointer" }}>Skip for now</button>
            </div>
          </div>
        )}

        {/* Step 3: House sheet ingestion */}
        {step === 2 && (
          <div className="ruled mt" style={{ padding: "1.2rem", maxWidth: "760px" }}>
            <span className="legend">Step 3 · hand us one example of your house tear sheet</span>
            <p className="prose small mt">
              Paste the text of a tear sheet you already use. We read the fields it asks for, bind each
              one to a concept we can compute, and capture your house style. Anything we cannot map is
              shown below as an honest abstention, for you to decide on, never guessed onto a number.
            </p>
            <div className="mt">
              <label className="prose small">A name for this house sheet (optional)
                <input className="ruled" style={inputStyle} value={exampleName} onChange={(e) => setExampleName(e.target.value)} placeholder="e.g. Acme standard credit sheet" />
              </label>
            </div>
            <div className="mt">
              <textarea className="ruled" style={{ ...inputStyle, minHeight: "180px", fontFamily: "var(--mono)" }} value={exampleText} onChange={(e) => setExampleText(e.target.value)} placeholder="Paste your example tear sheet text here…" />
            </div>
            <div className="mt" style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
              <button className="ruled" onClick={() => setExampleText(SAMPLE_SHEET)} style={{ padding: "0.6rem 1rem", cursor: "pointer" }}>Load a sample</button>
              <button className="ruled" onClick={induce} disabled={busy || !exampleText.trim()} style={{ padding: "0.6rem 1.2rem", cursor: "pointer" }}>{busy ? "…" : "Induce my house sheet"}</button>
            </div>

            {induced && (
              <div className="mt">
                <hr className="hairline" />
                <span className="legend">Induced: {induced.mappedCount} field{induced.mappedCount === 1 ? "" : "s"} mapped · currency {induced.spec.styleTokens.currencyDefault} · date {induced.spec.styleTokens.dateFormat}</span>
                <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "0.5rem" }}>
                  <thead>
                    <tr className="legend"><td style={{ padding: "0.3rem 0" }}>Your label</td><td>Concept</td><td>Required</td><td>Min rung</td></tr>
                  </thead>
                  <tbody>
                    {induced.spec.fields.map((f, i) => (
                      <tr key={f.key} style={{ borderTop: "1px solid var(--rule)" }}>
                        <td style={{ padding: "0.4rem 0", width: "40%" }}>
                          <input className="ruled" style={{ width: "100%", padding: "0.35rem 0.5rem" }} value={f.label} onChange={(e) => editField(i, { label: e.target.value })} />
                        </td>
                        <td className="legend">{f.key}</td>
                        <td><input type="checkbox" checked={f.required} onChange={(e) => editField(i, { required: e.target.checked })} /></td>
                        <td>
                          <select className="ruled" style={{ padding: "0.3rem 0.4rem" }} value={f.resolutionFloor ?? ""} onChange={(e) => editField(i, { resolutionFloor: (e.target.value || undefined) as Rung | undefined })}>
                            <option value="">any</option>
                            <option value="R1">R1</option>
                            <option value="R2">R2</option>
                            <option value="R3">R3</option>
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {induced.spec.skeleton.length > 0 && (
                  <p className="legend mt">Section order: {induced.spec.skeleton.join(" · ")}</p>
                )}

                {induced.unmapped.length > 0 && (
                  <div className="mt">
                    <span className="legend" style={{ color: "var(--accent)" }}>
                      Not mapped ({induced.unmapped.length}), shown honestly rather than guessed. Teach us any that should
                      map, and we will remember it for your next sheet.
                    </span>
                    <div className="mt" style={{ display: "grid", gap: "0.4rem" }}>
                      {induced.unmapped.map((u) => (
                        <div key={u} style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                          <span className="prose small" style={{ minWidth: "12rem" }}>{u}</span>
                          <select
                            className="ruled"
                            style={{ padding: "0.3rem 0.4rem" }}
                            value={resolveChoice[u] ?? ""}
                            onChange={(e) => setResolveChoice((c) => ({ ...c, [u]: e.target.value }))}
                          >
                            <option value="">leave unmapped</option>
                            {CONCEPT_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                          </select>
                          <button
                            className="ruled"
                            style={{ padding: "0.3rem 0.7rem", cursor: "pointer" }}
                            disabled={!resolveChoice[u]}
                            onClick={() => resolveAbstention(u, resolveChoice[u])}
                          >
                            Map it
                          </button>
                          <button
                            className="ruled legend"
                            style={{ padding: "0.3rem 0.6rem", cursor: "pointer" }}
                            onClick={() => dismissAbstention(u)}
                          >
                            Dismiss
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="mt" style={{ display: "flex", gap: "0.6rem" }}>
                  <button className="ruled" onClick={() => setStep(3)} disabled={busy} style={{ padding: "0.6rem 1.2rem", cursor: "pointer" }}>Looks right, review & activate →</button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Step 4: Review & activate */}
        {step === 3 && induced && (
          <div className="ruled mt" style={{ padding: "1.2rem", maxWidth: "620px" }}>
            <span className="legend">Step 4 · review and activate your house sheet</span>
            <div className="prose small mt">
              <div><strong>Spec:</strong> {induced.spec.name}</div>
              <div><strong>Fields:</strong> {induced.spec.fields.length} ({induced.spec.fields.filter((f) => f.required).length} required)</div>
              <div><strong>Style:</strong> {induced.spec.styleTokens.currencyDefault}, {induced.spec.styleTokens.dateFormat}, {induced.spec.styleTokens.voice}</div>
              <div><strong>Sections:</strong> {induced.spec.skeleton.join(" · ")}</div>
            </div>

            {!activated ? (
              <div className="mt" style={{ display: "flex", gap: "0.6rem" }}>
                <button className="ruled" onClick={activate} disabled={busy} style={{ padding: "0.6rem 1.2rem", cursor: "pointer" }}>{busy ? "…" : "Activate house sheet"}</button>
                <button className="ruled" onClick={() => setStep(2)} disabled={busy} style={{ padding: "0.6rem 1.2rem", cursor: "pointer" }}>← Back to edit</button>
              </div>
            ) : (
              <div className="mt">
                <p className="prose" style={{ color: "var(--accent)" }}>
                  Setup complete. Your house sheet is active (version {activated.version}). Every sheet
                  now renders in your style.
                </p>
                <div className="mt" style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
                  <Link href="/housesheet" className="stamp" style={{ background: "var(--ink)", color: "var(--paper)", borderColor: "var(--ink)", textDecoration: "none" }}>View your house sheet →</Link>
                  <Link href="/originate" className="stamp" style={{ background: "var(--ink)", color: "var(--paper)", borderColor: "var(--ink)", textDecoration: "none" }}>Originate a real target →</Link>
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      <hr className="hairline" />
      <section>
        <span className="legend"><Link href="/" style={{ color: "var(--accent)" }}>← Home</Link></span>
      </section>
    </main>
  );
}
