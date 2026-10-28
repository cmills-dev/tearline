// test/onboarding.test.ts
// Conversational onboarding, driven by a scripted mock LLM (no key). Confirms the deterministic
// slot flow fills the typed profile, that stated relationships SEED the graph as tenant-private
// edges with "stated by the client" provenance, and that nothing is fabricated from an empty answer.

import { suite, test, assert, assertEqual } from "./harness";
import { emptyProfile } from "../lib/onboarding/profile";
import { runTurn } from "../lib/onboarding/agent";
import { nextStep } from "../lib/onboarding/machine";
import { CLIENT_FIRM_NODE } from "../lib/onboarding/tools";
import { InMemoryGraphStore } from "../lib/graph/store";
import { warmestPaths } from "../lib/graph/path";
import { mockProvider } from "../lib/llm/mockProvider";

const T = "tenant-1";

suite("onboarding / conversational setup");

export async function registerOnboardingTests(): Promise<void> {
  const store = new InMemoryGraphStore();
  const profile = emptyProfile();
  const ctx = { tenantId: T, store };

  await runTurn(profile, "We're Northwind Capital", mockProvider('{"firmName":"Northwind Capital"}'), ctx);
  await runTurn(profile, "software and healthcare, mostly special situations", mockProvider('{"sectors":["software","healthcare","special situations"]}'), ctx);
  await runTurn(profile, "ten to a hundred million turnover", mockProvider('{"minTurnover":10000000,"maxTurnover":100000000}'), ctx);
  const relTurn = await runTurn(
    profile,
    "We've worked closely with Blackstone and we know Kirkland & Ellis well",
    mockProvider('{"relationships":[{"counterpartyName":"Blackstone","counterpartyType":"pe","relationship":"worked_with","strength":4},{"counterpartyName":"Kirkland & Ellis","counterpartyType":"law","relationship":"know","strength":5}]}'),
    ctx,
  );

  const pathToBlackstone = await warmestPaths(store, T, [CLIENT_FIRM_NODE], "firm:blackstone");

  // Honesty: an empty relationships answer seeds nothing.
  const p2 = emptyProfile();
  p2.firmName = "X"; p2.mandate = { sectors: ["x"], minTurnover: 1 }; // jump to relationships slot
  const store2 = new InMemoryGraphStore();
  const emptyRel = await runTurn(p2, "not sure yet", mockProvider('{"relationships":[]}'), { tenantId: T, store: store2 });

  test("fills the typed profile from the user's answers", () => {
    assertEqual(profile.firmName, "Northwind Capital", "firm captured");
    assert(profile.mandate.sectors?.includes("healthcare"), "sectors captured");
    assertEqual(profile.mandate.minTurnover, 10000000, "size captured");
    assertEqual(profile.relationships.length, 2, "two relationships captured");
  });

  test("stated relationships seed the graph as tenant-private, client-sourced edges", () => {
    assertEqual(relTurn.seededEdges, 2, "two edges seeded");
    assert(!!pathToBlackstone, "a warm path to Blackstone now exists");
    const hop = pathToBlackstone![0].hops[0];
    assertEqual(hop.provenance.source, "client-onboarding", "provenance is the client's statement");
  });

  test("an empty answer fabricates no relationship", () => {
    assertEqual(emptyRel.seededEdges, 0, "nothing seeded from an empty answer");
    assertEqual(p2.relationships.length, 0, "no relationship invented");
  });

  // The onboarding must not LOOP when the desk states no size, no relationships and no constraints.
  // Each optional slot is asked once (across stateless turns) then skipped even if left empty. The
  // profile is re-serialised each turn to mimic the HTTP round-trip that broke the old WeakSet.
  const p3 = emptyProfile();
  const store3 = new InMemoryGraphStore();
  const ctx3 = { tenantId: T, store: store3 };
  const roundtrip = (p: typeof p3) => JSON.parse(JSON.stringify(p)) as typeof p3;
  let p = p3 as ReturnType<typeof roundtrip>;
  let last = await runTurn(p, "We're Solo Desk", mockProvider('{"firmName":"Solo Desk"}'), ctx3); p = roundtrip(last.profile);
  last = await runTurn(p, "generalist", mockProvider('{"sectors":["generalist"]}'), ctx3); p = roundtrip(last.profile);
  last = await runTurn(p, "no size preference", mockProvider('{"minTurnover":null,"maxTurnover":null}'), ctx3); p = roundtrip(last.profile);
  last = await runTurn(p, "none really", mockProvider('{"relationships":[]}'), ctx3); p = roundtrip(last.profile);
  last = await runTurn(p, "no constraints", mockProvider('{"constraints":[]}'), ctx3); p = roundtrip(last.profile);

  test("onboarding completes and never loops when size, relationships and constraints are all empty", () => {
    assert(last.done, "the flow reaches completion");
    assert(!nextStep(p), "no further step is pending after the optional slots were asked once");
    assertEqual(p.mandate.minTurnover, undefined, "no size was invented");
    assertEqual(p.relationships.length, 0, "no relationship was invented");
    assert((p.answeredSlots ?? []).includes("constraints"), "constraints recorded as asked, so it is not re-asked");
  });
}
