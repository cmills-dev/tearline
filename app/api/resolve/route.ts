// app/api/resolve/route.ts
// Entity-resolution review endpoint, tenant-scoped. One POST, dispatched on `action`:
//   - "run"         : run the resolution + LEI-merge pass over the tenant's graph and return a
//                     summary (resolved / merged / unresolved-for-review).
//   - "merge"       : confirm a specific manual merge { keepId, dropId }.
//   - "confirm-lei" : accept a proposed LEI for an unresolved node { nodeId, lei, confidence? }.
//   - "reject-lei"  : reject a proposed LEI { nodeId } - the node is marked ambiguous so it is not
//                     re-proposed, and is NEVER auto-merged.
// The wall holds throughout: every store call is fenced to the tenant, and a merge can only ever
// fold two nodes inside the same tenant.

import { NextResponse } from "next/server";
import { readJsonObject, textField } from "@/lib/http/body";
import { getTenantId } from "@/lib/tenant";
import { getGraphStore } from "@/lib/graph/store";
import { resolveAndMergeGraph } from "@/lib/graph/resolve";

export const dynamic = "force-dynamic";

interface Body {
  action?: "run" | "merge" | "confirm-lei" | "reject-lei";
  keepId?: string;
  dropId?: string;
  nodeId?: string;
  lei?: string;
  confidence?: number;
}

export async function POST(req: Request) {
  const tenantId = await getTenantId();
  if (!tenantId) return NextResponse.json({ error: "No tenant in context." }, { status: 401 });

  const body = (await readJsonObject(req)) as Body;
  const store = getGraphStore();

  try {
    switch (body.action) {
      case "run": {
        const summary = await resolveAndMergeGraph(store, tenantId);
        return NextResponse.json({ ok: true, summary });
      }

      case "merge": {
        const keepId = textField(body.keepId).trim();
        const dropId = textField(body.dropId).trim();
        if (!keepId || !dropId) {
          return NextResponse.json({ error: "keepId and dropId are required." }, { status: 400 });
        }
        // Refuse to fuse two DIFFERENT resolved entities: if both nodes carry a LEI and the LEIs
        // disagree, this is a mis-link, not a merge. Abstain rather than corrupt the graph.
        const keepNode = await store.getNode(tenantId, keepId);
        const dropNode = await store.getNode(tenantId, dropId);
        if (!keepNode || !dropNode) {
          return NextResponse.json({ error: "Both nodes must exist in this tenant." }, { status: 404 });
        }
        if (keepNode.lei && dropNode.lei && keepNode.lei !== dropNode.lei) {
          return NextResponse.json(
            { error: "Refusing to merge: the two nodes carry different confirmed LEIs (different entities)." },
            { status: 409 },
          );
        }
        await store.mergeNodes(tenantId, keepId, dropId);
        return NextResponse.json({ ok: true, keepId, dropId });
      }

      case "confirm-lei": {
        const nodeId = textField(body.nodeId).trim();
        const lei = textField(body.lei).trim().toUpperCase();
        if (!nodeId || !lei) {
          return NextResponse.json({ error: "nodeId and lei are required." }, { status: 400 });
        }
        // A LEI is exactly 20 chars: 18 alphanumeric + a 2-digit check. Reject anything else so a
        // typo or a hostile client cannot stamp a node with a junk key that a later run would merge on.
        if (!/^[A-Z0-9]{18}[0-9]{2}$/.test(lei)) {
          return NextResponse.json({ error: "That is not a valid LEI (20 characters)." }, { status: 400 });
        }
        const node = await store.getNode(tenantId, nodeId);
        if (!node) return NextResponse.json({ error: "Node not found in this tenant." }, { status: 404 });
        // A human has confirmed the evidence, so this becomes a resolved canonical key. Confidence
        // is clamped to [0,1] so a crafted body cannot push it out of range.
        const confidence = Math.min(1, Math.max(0, typeof body.confidence === "number" ? body.confidence : 0.95));
        await store.addNode({ ...node, lei, resolutionStatus: "resolved", resolutionConfidence: confidence });
        return NextResponse.json({ ok: true, nodeId, lei });
      }

      case "reject-lei": {
        const nodeId = textField(body.nodeId).trim();
        if (!nodeId) return NextResponse.json({ error: "nodeId is required." }, { status: 400 });
        const node = await store.getNode(tenantId, nodeId);
        if (!node) return NextResponse.json({ error: "Node not found in this tenant." }, { status: 404 });
        // The human said this is not the entity: mark it ambiguous so it drops out of the
        // auto-proposal, keep it name-only, and never link or merge it.
        await store.addNode({ ...node, resolutionStatus: "ambiguous" });
        return NextResponse.json({ ok: true, nodeId });
      }

      default:
        return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }
  } catch (e) {
    // The detail goes to the log, not the caller: a driver, register or TypeError message is
    // not something a client should read (WP-QA03).
    console.error(`${new URL(req.url).pathname} failed:`, e);
    return NextResponse.json({ error: "The request could not be completed." }, { status: 500 });
  }
}
