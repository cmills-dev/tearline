import Link from "next/link";

export default function NotFound() {
  return (
    <main className="frame doc" style={{ paddingTop: "3rem" }}>
      <span className="legend">Not on file</span>
      <h1 style={{ marginTop: "0.5rem" }}>No tear sheet at this reference.</h1>
      <p className="prose mt">
        The requested borrower is not in the illustrative set. Return to the entry field and try one of the
        two demo companies.
      </p>
      <p className="mt">
        <Link href="/" className="legend" style={{ color: "var(--accent)" }}>
          ← Back to entry
        </Link>
      </p>
    </main>
  );
}
