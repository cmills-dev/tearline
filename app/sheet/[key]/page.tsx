import Link from "next/link";
import { notFound } from "next/navigation";
import { getTenantId } from "@/lib/tenant";
import { getTearSheet } from "@/lib/workspace";
import SheetView from "@/app/components/SheetView";
import SignInGate from "@/app/components/SignInGate";

// Per-tenant and dynamic: the sheet is generated once, saved to the tenant's
// workspace, then read back from the store on later views.
export const dynamic = "force-dynamic";

export default async function SheetPage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  const { key } = await params;
  const tenantId = await getTenantId();
  if (!tenantId) {
    return (
      <SignInGate
        legend="Tear sheet · tenant-scoped"
        title="Sign in to open a saved sheet."
        body="Saved sheets are bound to your tenant and invisible to any other."
      />
    );
  }
  const resolved = await getTearSheet(tenantId, key);
  if (!resolved) notFound();
  const { ts, fromStore, durable } = resolved;

  return (
    <>
      <div className="frame" style={{ paddingTop: "1.4rem", paddingBottom: 0 }}>
        <div
          className="ruled"
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: "1rem",
            padding: "0.5rem 0.9rem",
            flexWrap: "wrap",
          }}
        >
          <span className="legend">
            {fromStore ? "Loaded from your workspace" : "Saved to your workspace"} ·{" "}
            {durable ? "durable store (survives restart)" : "in-memory store (this session)"}
          </span>
          <span className="legend">
            <Link href="/workspace" style={{ color: "var(--accent)" }}>
              Your workspace →
            </Link>
          </span>
        </div>
      </div>
      <SheetView ts={ts} />
    </>
  );
}
