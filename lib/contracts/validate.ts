// lib/contracts/validate.ts
// Runtime validators for the frozen contracts. These run at trust boundaries - before a
// FactManifest is persisted, or when one is read back from storage or an external caller
// - so a malformed or contract-violating object is rejected loudly rather than stored and
// silently mis-rendered. Pure, dependency-free.

import type { ClientSpec } from "./clientSpec";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const RUNGS = ["R1", "R2", "R3", "R4"];

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// Validate a single Fact. Returns the list of problems (empty if valid). Enforces the two
// contract invariants the ladder relies on: an R4 fact abstains (null value), and an R1
// reported fact with a value carries provenance (a number with nowhere to check is a bug).
export function validateFact(x: unknown, path = "fact"): string[] {
  const e: string[] = [];
  if (!isObj(x)) return [`${path}: not an object`];
  for (const k of ["id", "metric", "label", "period", "kind", "unit"]) {
    if (typeof x[k] !== "string") e.push(`${path}.${k}: expected string`);
  }
  if (!RUNGS.includes(x.rung as string)) {
    e.push(`${path}.rung: expected one of ${RUNGS.join("/")}`);
  }
  const v = x.value;
  if (!(v === null || typeof v === "number" || typeof v === "string")) {
    e.push(`${path}.value: expected number | string | null`);
  }
  // A numeric value must be finite: NaN / Infinity are never a real figure and must not persist.
  if (typeof v === "number" && !Number.isFinite(v)) {
    e.push(`${path}.value: a numeric value must be finite (not NaN or Infinity)`);
  }
  if (x.rung === "R4" && v !== null) {
    e.push(`${path}: an R4 (abstain) fact must have a null value`);
  }
  if (x.rung === "R1" && v !== null && !isObj(x.provenance)) {
    e.push(`${path}: an R1 reported fact must carry provenance`);
  }
  // A synthesised (R2) or proxied (R3) number must carry an audit trail: a derivation OR a
  // provenance. A figure at the persistence boundary with neither is uncited and must be rejected.
  if ((x.rung === "R2" || x.rung === "R3") && v !== null && !isObj(x.derivation) && !isObj(x.provenance)) {
    e.push(`${path}: an R2/R3 fact must carry a derivation or provenance`);
  }
  if (!isObj(x.verification)) {
    e.push(`${path}.verification: expected a verification state object`);
  }
  return e;
}

export function validateFactManifest(x: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObj(x)) return { ok: false, errors: ["manifest: not an object"] };

  if (!isObj(x.entity)) {
    errors.push("manifest.entity: expected an entity object");
  } else {
    if (typeof x.entity.companyName !== "string") {
      errors.push("manifest.entity.companyName: expected string");
    }
    if (typeof x.entity.synthetic !== "boolean") {
      errors.push("manifest.entity.synthetic: expected boolean (real vs illustrative must be explicit)");
    }
  }

  if (!isObj(x.facts)) {
    errors.push("manifest.facts: expected a record of facts");
  } else {
    for (const [k, f] of Object.entries(x.facts)) {
      errors.push(...validateFact(f, `manifest.facts.${k}`));
    }
  }

  if (!isObj(x.sources)) {
    errors.push("manifest.sources: expected a record of source documents");
  }

  return { ok: errors.length === 0, errors };
}

export function validateClientSpec(x: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObj(x)) return { ok: false, errors: ["clientSpec: not an object"] };
  for (const k of ["contractVersion", "clientId", "name"]) {
    if (typeof x[k] !== "string") errors.push(`clientSpec.${k}: expected string`);
  }
  if (typeof x.version !== "number") errors.push("clientSpec.version: expected number");
  if (!Array.isArray(x.fields)) {
    errors.push("clientSpec.fields: expected an array");
  } else {
    (x.fields as unknown[]).forEach((f, i) => {
      if (!isObj(f)) {
        errors.push(`clientSpec.fields[${i}]: not an object`);
        return;
      }
      for (const k of ["key", "label", "ontologyConcept"]) {
        if (typeof f[k] !== "string") errors.push(`clientSpec.fields[${i}].${k}: expected string`);
      }
      if (typeof f.required !== "boolean") errors.push(`clientSpec.fields[${i}].required: expected boolean`);
    });
  }
  if (!Array.isArray(x.skeleton)) errors.push("clientSpec.skeleton: expected an array of section slots");
  if (!isObj(x.styleTokens)) errors.push("clientSpec.styleTokens: expected an object");
  return { ok: errors.length === 0, errors };
}

// Narrowing helpers for callers that want a boolean gate rather than the error list.
export function isValidFactManifest(x: unknown): boolean {
  return validateFactManifest(x).ok;
}
export function isValidClientSpec(x: unknown): x is ClientSpec {
  return validateClientSpec(x).ok;
}
