// lib/onboarding/agent.ts
// The onboarding agent: for the current slot, it asks the model-agnostic LLM to PARSE the
// user's free-text answer into the slot's typed JSON, applies it via the validated tools
// (which seed the graph for relationships), and returns a confirmation plus the next
// question. The model never decides values or invents relationships - it only extracts what
// the user said into a fixed schema, and every capture is echoed back for confirmation.

import type { LLMProvider } from "../llm/types";
import type { OnboardingProfile } from "./profile";
import { nextStep, progress, type Step } from "./machine";
import { applyExtraction, type ApplyContext } from "./tools";

export interface TurnResult {
  profile: OnboardingProfile;
  confirmation: string; // what we captured, for the user to confirm
  nextQuestion: string; // the next slot's question, or a wrap-up
  done: boolean;
  seededEdges: number;
}

function stripFences(s: string): string {
  return s.replace(/^\s*```[a-z]*\s*/i, "").replace(/\s*```\s*$/i, "").trim();
}
function parseJson(s: string): unknown {
  try {
    return JSON.parse(stripFences(s));
  } catch {
    // best effort: grab the first {...} block
    const m = s.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function extractionPrompt(step: Step, userText: string): { system: string; user: string } {
  return {
    system: [
      "You extract structured data from what a user says during onboarding.",
      "You ONLY output JSON matching the given schema. You never invent values the user did not state;",
      "for anything the user did not provide, use null or an empty array. No prose, no code fences.",
    ].join(" "),
    user: `Schema: ${step.schemaHint}\n\nUser said: "${userText}"\n\nReturn the JSON.`,
  };
}

// Confirmation text for what was captured, so the user can correct it. Never claims more
// than was captured.
function confirmationFor(step: Step, profile: OnboardingProfile, seeded: number): string {
  switch (step.slot) {
    case "firmName":
      return profile.firmName ? `Noted: your firm is ${profile.firmName}.` : "I didn't catch the firm name - could you repeat it?";
    case "mandateSectors":
      return profile.mandate.sectors?.length ? `Noted focus: ${profile.mandate.sectors.join(", ")}.` : "I didn't catch a sector - could you say which areas you focus on?";
    case "mandateSize": {
      const { minTurnover: lo, maxTurnover: hi } = profile.mandate;
      if (lo === undefined && hi === undefined) return "No size range captured - that's fine, we can leave it open.";
      const fmt = (n?: number) => (n === undefined ? "" : `£${(n / 1e6).toFixed(0)}m`);
      return `Noted target size: ${fmt(lo) || "any"} to ${fmt(hi) || "any"}.`;
    }
    case "relationships":
      return seeded > 0
        ? `Noted ${seeded} relationship${seeded > 1 ? "s" : ""}, added to your private network (stated by you). None of this is shared or resold.`
        : "No relationships captured yet - you can add them any time.";
    case "constraints":
      return profile.constraints.length ? `Noted no-go areas: ${profile.constraints.join(", ")}.` : "No constraints noted.";
    default:
      return "";
  }
}

export async function runTurn(
  profile: OnboardingProfile,
  userText: string,
  provider: LLMProvider | null,
  ctx: ApplyContext,
): Promise<TurnResult> {
  const step = nextStep(profile);
  if (!step) {
    profile.confirmed = true;
    return { profile, confirmation: "", nextQuestion: "That's everything I need - I'll build your workspace and origination shortlist now.", done: true, seededEdges: 0 };
  }

  // With an LLM configured, parse the answer into the slot's JSON; without one, fall back to
  // a deterministic heuristic parser so the onboarding still works with no key (degraded).
  let value: unknown;
  if (provider) {
    const { system, user } = extractionPrompt(step, userText);
    const raw = await provider.complete({ system, user, maxTokens: 800 });
    value = parseJson(raw);
  } else {
    value = heuristicExtract(step.slot, userText);
  }
  const { seeded } = await applyExtraction(profile, step.slot, value, ctx);
  // Record the slot as answered AFTER applying the user's input, so the answer is never lost, and an
  // optional slot left empty is not re-asked on the next stateless turn (see machine.nextStep).
  if (!profile.answeredSlots) profile.answeredSlots = [];
  if (!profile.answeredSlots.includes(step.slot)) profile.answeredSlots.push(step.slot);

  const confirmation = confirmationFor(step, profile, seeded);
  const next = nextStep(profile);
  const p = progress(profile);
  const nextQuestion = next
    ? next.question
    : `That's the core captured (${p.filled}/${p.total}). Ready for me to build your workspace and origination shortlist?`;
  return { profile, confirmation, nextQuestion, done: !next, seededEdges: seeded };
}

// The opening question, before any user input.
export function openingQuestion(): string {
  return nextStep({ mandate: {}, relationships: [], constraints: [], confirmed: false })!.question;
}

// Deterministic no-key fallback parser. Conservative: it captures only what it can read
// plainly and never invents a value it did not see.
function heuristicExtract(slot: string, text: string): unknown {
  const t = text.trim();
  switch (slot) {
    case "firmName":
      return { firmName: t.replace(/^(we(?:'re| are)|it's|our firm is|this is)\s+/i, "").replace(/[.]$/, "").trim() };
    case "mandateSectors":
      return { sectors: t.split(/,|;|\band\b|&|\//i).map((s) => s.trim()).filter((s) => s.length > 1) };
    case "mandateSize": {
      const nums = [...t.matchAll(/(\d+(?:\.\d+)?)\s*(bn|billion|m|million|k)?/gi)].map((mm) => {
        const n = parseFloat(mm[1]);
        const u = (mm[2] || "").toLowerCase();
        return u.startsWith("b") ? n * 1e9 : u.startsWith("m") ? n * 1e6 : u === "k" ? n * 1e3 : n * 1e6; // assume £m if unqualified
      });
      if (nums.length >= 2) return { minTurnover: Math.min(nums[0], nums[1]), maxTurnover: Math.max(nums[0], nums[1]) };
      if (nums.length === 1) return { maxTurnover: nums[0] };
      return {};
    }
    case "relationships": {
      const typeOf = (s: string) => {
        const l = s.toLowerCase();
        if (/\bllp\b|law|solicitor|kirkland|freshfields|clifford|linklaters|allen|slaughter/.test(l)) return "law";
        if (/bank|lloyds|hsbc|barclays|natwest|santander/.test(l)) return "lender";
        if (/capital|partners|equity|advisors?|advisers?/.test(l)) return "pe";
        return "adviser";
      };
      const names = t.split(/,|;|\band\b|&/i).map((s) => s.replace(/^(we(?:'ve| have)?|know|worked with|closely)\s+/i, "").trim()).filter((s) => s.length > 2 && /[A-Za-z]/.test(s));
      return { relationships: names.map((n) => ({ counterpartyName: n, counterpartyType: typeOf(n), relationship: "know", strength: 3 })) };
    }
    case "constraints":
      return { constraints: t.toLowerCase().startsWith("no") && t.length < 6 ? [] : t.split(/,|;|\band\b/i).map((s) => s.trim()).filter((s) => s.length > 1) };
    default:
      return {};
  }
}
