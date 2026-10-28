// app/components/SignInGate.tsx
// A full-page sign-in gate for tenant-scoped server pages. In enforced-auth mode
// (AUTH_REQUIRED=1) getTenantId() returns "" for an unauthenticated request; a page must
// not proceed to read, save or list under the empty tenant, or two anonymous users would
// share one "" workspace. Each guarded page renders this instead when tenantId is empty.

import Link from "next/link";

export default function SignInGate({
  legend,
  title,
  body,
}: {
  legend: string;
  title: string;
  body: string;
}) {
  return (
    <main className="frame doc">
      <section style={{ paddingTop: "2.6rem" }}>
        <span className="legend">{legend}</span>
        <h1 style={{ marginTop: "0.6rem" }}>{title}</h1>
        <p className="prose mt">
          {body}{" "}
          <Link href="/login" style={{ color: "var(--accent)" }}>
            Sign in →
          </Link>
        </p>
      </section>
    </main>
  );
}
