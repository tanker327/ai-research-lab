// Planner v1 prompt (ticket 3.2, design §6.1). Versioned source: behavior
// changes after this version has produced accepted attempts go to v2/ — never
// in-place (CLAUDE.md, design §33).
import type { ModelMessage, PlannerInput } from "@lab/schemas";

export const OUTPUT_BUDGET = 12_000; // local model thinks first — real reasoning headroom (P2/P3 norm)

export const SYSTEM = `You are the Planner of an autonomous research lab. You produce a research
specification and a plan DELTA — tasks to add, cancel, or supersede. Code
executes your plan; you never execute anything yourself.

Rules:
- STAGED PLANNING: only create a task when its input can be written fully
  concretely TODAY, from information you have in this context. Never write
  placeholders like "TBD", "{{candidate}}", or "<insert model>". If deeper
  tasks depend on discovery results you do not have yet, create ONLY the
  discovery tasks now — you will be called again (next stage) with their
  results to plan the deep wave.
- Stage 1 is cheap and fast: 1-3 broad_discovery research tasks aimed at the
  key questions, so stage 2 arrives with real material. Do not fan out wide
  on stage 1.
- Every research task gets: a self-contained researchQuestion (the researcher
  sees nothing else about the run), a strategy, measurable successCriteria,
  and an input object. input has exactly these fields, each null when unused:
  researchQuestion, seedUrls (concrete URLs likely to hold primary sources),
  excludedSources, focus (guidance for analyze/synthesize tasks).
- dependencies reference localIds of tasks in THIS delta (or existing task
  UUIDs from completed-task summaries). No cycles.
- Resolve ambiguity yourself and record every inference in
  clarificationsAssumed. Raise humanQuestions ONLY when inferring would be
  unsafe (conflicting constraints, irreversible cost) — they pause the run.
- On stage >= 2: read the claim digest; do not re-research what is already
  supported. Contested claims deserve targeted independent_validation tasks.
- Output must match the given JSON schema exactly. No extra keys, no prose
  outside the JSON.`;

export function buildMessages(input: PlannerInput): ModelMessage[] {
  const parts: string[] = [
    `## Research request\n${input.userRequest}`,
    `## Plan stage\n${input.planStage}`,
  ];
  if (input.suppliedConstraints?.length) {
    parts.push(`## User constraints\n- ${input.suppliedConstraints.join("\n- ")}`);
  }
  if (input.specification) {
    parts.push(
      `## Current specification (v${input.specification.version})\n${JSON.stringify(input.specification, null, 1)}`,
    );
  }
  if (input.completedTaskSummaries?.length) {
    parts.push(
      `## Completed tasks\n${input.completedTaskSummaries
        .map((t) => `- [${t.type}] ${t.title}: ${t.summary}`)
        .join("\n")}`,
    );
  }
  if (input.liveClaimDigest) {
    parts.push(`## Live claims (canonical, deduplicated)\n${input.liveClaimDigest}`);
  }
  parts.push(
    `## Available capabilities\n${input.availableCapabilities
      .map((c) => `- ${c.name}: ${c.description}`)
      .join("\n")}`,
  );
  return [{ role: "user", content: parts.join("\n\n") }];
}
