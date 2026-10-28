// app/api/onboarding/route.ts
// The conversational onboarding endpoint. Each POST runs one turn: parse the user's answer
// into the current typed slot, apply it (seeding the relationship graph for stated
// relationships), and return the confirmation + next question. Tenant-scoped; uses the
// configured LLM if present, else the deterministic no-key fallback.

import { NextResponse } from "next/server";
import { readJsonObject, textField } from "@/lib/http/body";
import { getTenantId } from "@/lib/tenant";
import { getGraphStore } from "@/lib/graph/store";
import { getProvider } from "@/lib/llm/config";
import { runTurn, openingQuestion } from "@/lib/onboarding/agent";
import { profileFromWire, type OnboardingProfile } from "@/lib/onboarding/profile";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ opening: openingQuestion(), usingLlm: !!getProvider() });
}

export async function POST(req: Request) {
  const tenantId = await getTenantId();
  // Gate like every sibling onboarding route: in enforced-auth mode an unauthenticated caller
  // resolves to the empty tenant, and without this guard runTurn would seed graph nodes/edges under
  // a shared "" bucket that other unauthenticated callers could then read back.
  if (!tenantId) return NextResponse.json({ error: "You must be signed in." }, { status: 401 });
  const body = (await readJsonObject(req)) as { profile?: OnboardingProfile; userText?: string };
  const profile = profileFromWire(body.profile);
  // Cap the free-text answer so it cannot balloon an LLM prompt (cost) or the heuristic parser.
  const userText = textField(body.userText).slice(0, 4000);
  const result = await runTurn(profile, userText, getProvider(), { tenantId, store: getGraphStore() });
  return NextResponse.json({
    profile: result.profile,
    confirmation: result.confirmation,
    nextQuestion: result.nextQuestion,
    done: result.done,
    seededEdges: result.seededEdges,
  });
}
