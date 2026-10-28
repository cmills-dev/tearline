// test/clientspec-promote.test.ts
// RSI Phase 3: the pure promotion policy for the shared vocabulary dictionary. These tests pin the
// gates that decide whether a cross-tenant synonym candidate may enter the shared dictionary:
// k-anonymity, the identifying-token filter, and base-dictionary conflict. The doctrine is to
// reject on uncertainty, so a candidate that trips ANY gate must never be marked promote:true.
// Pure functions only (no store, no I/O); async registrar to match the suite's shape.

import { suite, test, assert, assertEqual } from "./harness";
import {
  DEFAULT_K,
  passesAnonymity,
  passesTokenFilter,
  conflictsWithBase,
  decideCandidates,
} from "../lib/clientspec/promote";
import type { SynonymCandidate, CandidateStatus } from "../lib/clientspec/types";

function candidate(
  labelNorm: string,
  conceptKey: string,
  distinctTenants: number,
  status: CandidateStatus = "pending"
): SynonymCandidate {
  return { labelNorm, conceptKey, distinctTenants, status };
}

export async function registerClientSpecPromoteTests(): Promise<void> {
  suite("clientspec / promote");

  // --- (a) k-anonymity -----------------------------------------------------
  test("anonymity: below k fails, at k passes (default k = 3)", () => {
    assertEqual(DEFAULT_K, 3, "the default k-anonymity threshold is 3");
    assertEqual(passesAnonymity(candidate("top line", "turnover", 2)), false, "2 distinct tenants fails at k=3");
    assertEqual(passesAnonymity(candidate("top line", "turnover", 3)), true, "3 distinct tenants passes at k=3");
    assertEqual(passesAnonymity(candidate("top line", "turnover", 2), 2), true, "an explicit lower k lets 2 pass");
  });

  // --- (b) token filter ----------------------------------------------------
  test("token filter rejects identifying, digit-bearing, too-short and too-long labels", () => {
    assertEqual(passesTokenFilter("acme ltd").ok, false, "a company-form token is rejected");
    assertEqual(passesTokenFilter("revenue 2024").ok, false, "a label with a digit is rejected");
    assertEqual(passesTokenFilter("x").ok, false, "a too-short label is rejected");
    assertEqual(
      passesTokenFilter("senior secured loan facility agreement summary").ok,
      false,
      "a too-long label is rejected"
    );
  });

  test("token filter accepts clean generic vocabulary", () => {
    const topLine = passesTokenFilter("top line");
    const adjusted = passesTokenFilter("adjusted result");
    assertEqual(topLine.ok, true, "top line is accepted");
    assertEqual(adjusted.ok, true, "adjusted result is accepted");
    assert(topLine.reason === undefined, "an accepted label carries no reason");
  });

  test("a rejected token verdict carries a reason", () => {
    const verdict = passesTokenFilter("acme ltd");
    assert(typeof verdict.reason === "string" && verdict.reason.length > 0, "the rejection explains itself");
  });

  // --- (c) conflictsWithBase ------------------------------------------------
  test("conflictsWithBase: a mapping fighting the base dictionary is rejected", () => {
    // The base dictionary maps "revenue" -> turnover, so remapping it to ebitda conflicts.
    assertEqual(
      conflictsWithBase({ labelNorm: "revenue", conceptKey: "ebitda" }),
      true,
      "revenue -> ebitda conflicts with the base revenue -> turnover"
    );
    // A label the base dictionary does not know does not conflict.
    assertEqual(
      conflictsWithBase({ labelNorm: "top line", conceptKey: "turnover" }),
      false,
      "top line -> turnover does not conflict (base does not know top line)"
    );
    // Re-affirming what the base already says is not a conflict.
    assertEqual(
      conflictsWithBase({ labelNorm: "revenue", conceptKey: "turnover" }),
      false,
      "revenue -> turnover agrees with the base and does not conflict"
    );
  });

  // --- (d) unreal concept key ----------------------------------------------
  test("conflictsWithBase rejects a mapping onto a concept that does not exist", () => {
    assertEqual(
      conflictsWithBase({ labelNorm: "top line", conceptKey: "notaconcept" }),
      true,
      "an unreal conceptKey can never be promoted"
    );
  });

  // --- (e) decideCandidates -------------------------------------------------
  test("decideCandidates: a clean, k-anonymous, non-conflicting candidate promotes", () => {
    const [decision] = decideCandidates([candidate("top line", "turnover", 3)]);
    assertEqual(decision.promote, true, "the clean candidate is promoted");
    assertEqual(decision.reasons.length, 0, "a promoted candidate has no failing gates");
    assertEqual(decision.entry.labelNorm, "top line", "the decision carries the entry label");
    assertEqual(decision.entry.conceptKey, "turnover", "the decision carries the entry concept");
  });

  test("decideCandidates: a candidate failing a gate does not promote and names the reason", () => {
    const decisions = decideCandidates([
      candidate("top line", "turnover", 2), // fails k-anonymity
      candidate("acme ltd", "turnover", 3), // fails token filter
      candidate("revenue", "ebitda", 3), // conflicts with base
      candidate("top line", "turnover", 3, "rejected"), // rejected in review
    ]);

    assertEqual(decisions.length, 4, "decisions preserve input order and count");

    assertEqual(decisions[0].promote, false, "the low-anonymity candidate does not promote");
    assert(decisions[0].reasons.some((r) => r.includes("k-anonymity")), "it names the k-anonymity gate");

    assertEqual(decisions[1].promote, false, "the identifying-token candidate does not promote");
    assert(decisions[1].reasons.some((r) => r.includes("token filter")), "it names the token gate");

    assertEqual(decisions[2].promote, false, "the conflicting candidate does not promote");
    assert(decisions[2].reasons.some((r) => r.includes("base dictionary")), "it names the base-conflict gate");

    assertEqual(decisions[3].promote, false, "the rejected candidate does not promote");
    assert(decisions[3].reasons.some((r) => r.includes("rejected")), "it names the review-rejection gate");
  });
}
