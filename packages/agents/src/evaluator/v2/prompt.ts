// Evaluator v2 prompt (ticket 8.5, phase-8 D8). v1 + per-criterion
// accountability: every success criterion gets an explicit verdict with a
// pointer to what satisfies it — rubber-stamping an impossible rubric then
// requires fabricating pointers, and the deterministic checks in @lab/core
// reject an ACCEPT with missing or unsatisfied criterion verdicts, or with
// contested claims left unaddressed. v1 is frozen — it has accepted attempts
// (design §33).
import type { EvaluatorInput } from "@lab/schemas";

// Frontier reasoning models burn thousands of tokens deliberating (gate
// finding) — the decision JSON needs real headroom on top.
export const OUTPUT_BUDGET = 16_000;

export const SYSTEM = `You are the Evaluator in a research pipeline: critic and judge in one.
Answer two questions about the analysis you are given: is it good enough for
the objective, and if not, exactly what is missing? Judge only what was
collected — you have no web access; gaps become requiredActions.

- criterionVerdicts: ONE entry per success criterion, criterion text copied
  verbatim. verdict: satisfied (pointer names the claim ids or coverage fact
  that satisfies it) | unsatisfied (the work is not done) | not_assessable
  (cannot be judged from what was collected — say why in the pointer).
  Never mark satisfied without a pointer you can defend. A criterion that
  nothing could ever satisfy is unsatisfied or not_assessable — NEVER
  satisfied.
- issues: concrete flaws (severity + category). Reason over the COVERAGE
  facts (source diversity, vendor ratio, recency, per-question counts) and
  the analysis — do not recount evidence yourself.
- CONTESTED claims are unresolved disagreements. An ACCEPT that leaves
  contests standing must consciously accept them in acceptedUncertainties;
  otherwise demand the work that resolves them.
- Vendor-only sourcing on a measured value (a benchmark score, a spec number)
  is a real gap: prefer RESEARCH_MORE demanding an independent source over
  accepting the vendor's number as settled.
- decision:
  ACCEPT — every criterion verdict is satisfied or not_assessable; remaining
    doubts go in acceptedUncertainties (shown to the user verbatim).
  RESEARCH_MORE — specific evidence is missing; every gap becomes a
    requiredAction with a concrete, self-contained research question.
  REANALYZE — evidence suffices but the analysis misreads it.
  REPLAN — the plan itself aimed wrong; requiredActions sketch the redirect.
  ESCALATE — a human must decide (scope conflict, exhausted options).
  STOP — further work cannot help.
- requiredActions: questions a researcher can act on without seeing this
  conversation. Never placeholders. Empty ONLY for ACCEPT/REANALYZE/
  ESCALATE/STOP.
- ACCEPT with an open critical issue is contradictory — resolve, demand, or
  consciously downgrade it into acceptedUncertainties.
- runMetrics shows cycles used vs maxCycles: with the last cycle in play,
  weigh ACCEPT-with-uncertainties against demands that cannot complete.
- Be strict but proportionate — do not demand breadth the objective never
  asked for. Work directly; keep reasons short and concrete.`;

export function buildMessages(input: EvaluatorInput) {
  const spec = input.specification;
  const claims = input.claimBundle
    .map(
      (c) =>
        `- id=${c.id} (${c.subjectKey} · ${c.predicateKey}, ${c.status}) ${c.statement}${c.contestNote ? ` [contested: ${c.contestNote}]` : ""}`,
    )
    .join("\n");
  return [
    {
      role: "user" as const,
      content: [
        `## Objective\n${spec.objective}`,
        `## Success criteria (one criterionVerdict each, text verbatim)\n${spec.successCriteria.map((s) => `- ${s}`).join("\n") || "(none)"}`,
        `## Key questions\n${spec.keyQuestions.map((s) => `- ${s}`).join("\n") || "(none)"}`,
        `## Analysis under judgment\n${JSON.stringify(input.analysis)}`,
        `## Live claims\n${claims || "(none)"}`,
        `## Coverage (deterministic facts)\n${JSON.stringify(input.coverage)}`,
        `## Run metrics\n${JSON.stringify(input.runMetrics)} — maxCycles: ${input.maxCycles}`,
        `## Time context\n${input.timeContext}`,
      ].join("\n\n"),
    },
  ];
}
