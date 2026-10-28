import Link from "next/link";
import { demoIndex } from "@/lib/engine/pipeline";
import RunEntry from "./components/RunEntry";

export default function Home() {
  const demos = demoIndex();
  return (
    <main className="frame doc">
      <section style={{ paddingTop: "2.6rem" }}>
        <span className="legend">Confidential offering memorandum · live document</span>
        <h1 style={{ marginTop: "0.6rem", maxWidth: "18ch" }}>
          A name in. A cited tear sheet out.
        </h1>
        <p className="prose mt">
          Type a UK company name or a Companies House number. A number starts a run at once. A name is
          looked up on the register first, and where more than one company could be meant you pick the one
          you mean. The run reads the latest accounts filing, and every figure on the sheet carries the page
          it came from or abstains with its reason.
        </p>

        <div className="mt" style={{ maxWidth: "620px" }}>
          <RunEntry />
          <p className="legend mt">
            Every sheet a run saves goes to <Link href="/workspace" style={{ color: "var(--accent)" }}>your
            workspace</Link>, scoped to your tenant.
          </p>
        </div>
      </section>

      <hr className="hairline" />

      <section>
        <span className="legend">Two illustrative borrowers</span>
        <div className="card-grid mt">
          {demos.map((d) => (
            <Link
              key={d.key}
              href={`/sheet/${d.key}`}
              className="ruled"
              style={{ display: "block", padding: "1.2rem", textDecoration: "none" }}
            >
              <span className="legend">Company no. {d.companyNumber} · {d.accountsType} accounts</span>
              <h3 style={{ marginTop: "0.5rem" }}>{d.displayName}</h3>
              <p className="prose small mt">{d.thesis}</p>
              <span className="legend" style={{ color: "var(--accent)" }}>Open tear sheet →</span>
            </Link>
          ))}
        </div>
      </section>

      <hr className="hairline" />

      <section>
        <span className="legend">Live data · ESEF/UKSEF (EU + UK-listed groups)</span>
        <Link href="/esef" className="ruled" style={{ display: "block", padding: "1.2rem", textDecoration: "none", marginTop: "1rem" }}>
          <h3 style={{ marginTop: 0 }}>A listed group in. A full, cited tear sheet out.</h3>
          <p className="prose small mt">
            EU/UK-listed groups tag their IFRS consolidated statements in iXBRL with their regulator, even where they
            lodge only a scanned PDF at Companies House. Read from filings.xbrl.org, consolidated totals only, resolved
            to the group&rsquo;s LEI. No document parsing, no model, no key. Try Tesco PLC.
          </p>
          <span className="legend" style={{ color: "var(--accent)" }}>Open ESEF search →</span>
        </Link>
      </section>

      <hr className="hairline" />

      <section>
        <span className="legend">What makes this not a wrapper</span>
        <ul className="prose mt" style={{ paddingLeft: "1.1rem" }}>
          <li><strong>Fact-manifest-first.</strong> The sheet is a typed data structure before it is a document. The language plane cannot originate a number.</li>
          <li><strong>Resolution ladder.</strong> Every field resolves R1 reported → R2 synthesised → R3 labelled proxy → R4 abstain. Never a silent blank.</li>
          <li><strong>Evidence cards.</strong> Every figure opens its exact source snippet, locator, rung and a content hash. The viewer reads the card; it never rebuilds it.</li>
          <li><strong>ProseGate.</strong> A pure-code linter blocks AI-tell language before any prose ships.</li>
          <li><strong>Verification.</strong> Cross-field identities are run and shown. Honest labels only, never "verified" for one unchecked source.</li>
        </ul>
      </section>
    </main>
  );
}
