// Evaluator v1 prompt (ticket 4.3, design §6.5). Merged Critic + Judge on the
// frontier tier (json_object — deepseek reasons hard, keep the rubric TERSE,
// P3 norm). The output is a decision; the Control Plane interprets it and a
// deterministic guard bounds the loop (ADR-016) — nothing here relies on the
// model being the thing that stops.
import type { EvaluatorInput } from "@lab/schemas";

// Frontier reasoning models burn thousands of tokens deliberating (gate
// finding) — the decision JSON needs real headroom on top.
export const OUTPUT_BUDGET = 16_000;

export const SYSTEM = `You are the Evaluator in a research pipeline: critic and judge in one.
Answer two questions about the analysis you are given: is it good enough for
the objective, and if not, exactly what is missing? Judge only what was
collected — you have no web access; gaps become requiredActions.

- issues: concrete flaws (severity + category). Reason over the COVERAGE
  facts (source diversity, vendor ratio, recency, per-question counts) and
  the analysis — do not recount evidence yourself.
- decision:
  ACCEPT — success criteria met well enough; remaining doubts go in
    acceptedUncertainties (they will be shown to the user verbatim).
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
        `## Success criteria (judge against these)\n${spec.successCriteria.map((s) => `- ${s}`).join("\n") || "(none)"}`,
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
