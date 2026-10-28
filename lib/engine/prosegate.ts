// lib/engine/prosegate.ts
// ProseGate: a PURE-CODE readability linter. No model is involved. It scans generated
// prose for banned "AI tells", hedging, negative parallelism and process narration,
// and BLOCKS anything that trips a rule. All shipped prose is run through this gate,
// so the tear sheet a reader sees is provably clean by construction.

export interface ProseViolation {
  rule: string; // machine id of the rule
  description: string; // why it is banned
  match: string; // the offending text
  index: number; // character offset in the input
}

export interface ProseGateResult {
  clean: boolean;
  violations: ProseViolation[];
}

interface Rule {
  id: string;
  description: string;
  // a global, case-insensitive regex; each match is a violation
  pattern: RegExp;
}

// Word-boundary helper so "delve" does not fire inside "bedelved" etc.
const w = (s: string) => `\\b${s}\\b`;

const RULES: Rule[] = [
  {
    id: "banned-word:genuinely",
    description: 'Empty intensifier "genuinely".',
    pattern: new RegExp(w("genuinely"), "gi"),
  },
  {
    id: "banned-word:crucial",
    description: 'Filler emphasis "crucial" / "crucially".',
    pattern: new RegExp(w("crucial(?:ly)?"), "gi"),
  },
  {
    id: "banned-phrase:worth-noting",
    description: '"It\'s worth noting" is throat-clearing.',
    pattern: /it(?:'|’|\s+i)s worth noting/gi,
  },
  {
    id: "banned-phrase:the-true-story",
    description: '"The true story" editorialises.',
    pattern: /the true story/gi,
  },
  {
    id: "banned-word:delve",
    description: '"Delve" is an AI tell.',
    pattern: new RegExp(w("delve"), "gi"),
  },
  {
    id: "banned-word:leverage-verb",
    description: '"Leverage" as a verb. The noun (gearing) is allowed.',
    // verb use: "leverage the", "leveraging", "leverages X", "to leverage"
    pattern: /\b(?:to\s+)?leverage(?:s|d|ing)?\s+(?:the|a|an|its|their|our|these|this)\b/gi,
  },
  {
    id: "hedging:arguably",
    description: 'Hedging word "arguably".',
    pattern: new RegExp(w("arguably"), "gi"),
  },
  {
    id: "hedging:somewhat",
    description: 'Hedging word "somewhat".',
    pattern: new RegExp(w("somewhat"), "gi"),
  },
  {
    id: "negative-parallelism",
    description: 'Negative parallelism "not just X but Y".',
    pattern: /\bnot (?:just|only|merely|simply)\b[^.]*?\bbut\b/gi,
  },
  {
    id: "process-narration:let-me",
    description: 'Process narration "Let me ...".',
    pattern: /\blet me\b/gi,
  },
  {
    id: "process-narration:i-will-now",
    description: 'Process narration "I will now ..." / "I\'ll now ...".',
    pattern: /\bI(?: will|['’]ll) now\b/gi,
  },
  {
    id: "em-dash",
    description: "Em-dash is banned house style; use a full stop or comma.",
    pattern: /—/g,
  },
];

export function prosegate(text: string): ProseGateResult {
  const violations: ProseViolation[] = [];
  for (const rule of RULES) {
    // reset lastIndex defensively (rules are module-level and reused)
    rule.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.pattern.exec(text)) !== null) {
      violations.push({
        rule: rule.id,
        description: rule.description,
        match: m[0],
        index: m.index,
      });
      if (m.index === rule.pattern.lastIndex) rule.pattern.lastIndex++;
    }
  }
  violations.sort((a, b) => a.index - b.index);
  return { clean: violations.length === 0, violations };
}

// Assert-clean guard used by the language plane. Throws if any prose would ship
// dirty, so a violation is a build/runtime failure rather than a silent leak.
export function assertClean(text: string, context: string): string {
  const result = prosegate(text);
  if (!result.clean) {
    const summary = result.violations
      .map((v) => `[${v.rule}] "${v.match}" @${v.index}`)
      .join("; ");
    throw new Error(`ProseGate blocked prose in ${context}: ${summary}`);
  }
  return text;
}

export const PROSEGATE_RULE_IDS = RULES.map((r) => r.id);
