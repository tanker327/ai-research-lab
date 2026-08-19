// Two-pass research, pass-2 enqueue (ticket 3.4, design §6.3, ADR-012). When
// a research attempt is ACCEPTED, the Control Plane — not any agent — creates
// the extract task in the SAME transaction, with fully concrete input
// (ADR-011): the note artifact id, the mechanical source log, the question.
import {
  type Db,
  type EvaluationCandidate,
  insertPlannedTaskRow,
  insertTaskDependency,
  selectAttemptOutput,
  selectTaskForContext,
} from "@lab/db";
import { type ExtractorInput, newId, ResearcherOutput } from "@lab/schemas";
import { emitEvent } from "./events";
import { acceptAttemptInTx } from "./liveness";

const ACTOR = "extract_enqueuer";

export interface ResearchAcceptance {
  extractTaskId: string | null; // null: no ResearcherOutput (fake-handler era)
}

export async function acceptResearchAttempt(
  db: Db,
  c: EvaluationCandidate,
  maxAttemptsDefault: number,
): Promise<ResearchAcceptance> {
  return db.transaction(async (tx) => {
    await acceptAttemptInTx(tx, c.attemptId, ACTOR);

    const parsed = ResearcherOutput.safeParse(await selectAttemptOutput(tx, c.attemptId));
    if (!parsed.success) {
      // Fake-handler research tasks (demo chains, gates) have no researcher
      // output — visible in the trace, not an error.
      await emitEvent(tx, {
        runId: c.runId,
        taskId: c.taskId,
        attemptId: c.attemptId,
        type: "EXTRACT_SKIPPED",
        kind: "info",
        actor: ACTOR,
        payload: { reason: "attempt output is not a ResearcherOutput" },
      });
      return { extractTaskId: null };
    }

    const research = await selectTaskForContext(tx, c.taskId);
    const question = String(research?.input.researchQuestion ?? research?.title ?? "");
    const input: ExtractorInput = {
      noteArtifactId: parsed.data.noteArtifactId,
      sourcesVisited: parsed.data.sourcesVisited,
      question,
    };
    const extractTaskId = newId();
    await insertPlannedTaskRow(tx, {
      id: extractTaskId,
      runId: c.runId,
      planStage: research?.planStage ?? 1,
      specVersion: research?.specVersion ?? 1,
      type: "extract",
      title: `extract: ${(research?.title ?? question).slice(0, 480)}`,
      description: "",
      priority: research?.priority ?? 50,
      agentRole: "extractor",
      modelTier: null,
      strategy: null,
      input: input as unknown as Record<string, unknown>,
      successCriteria: [],
      maxAttempts: maxAttemptsDefault,
    });
    await insertTaskDependency(tx, extractTaskId, c.taskId); // DONE dep — readiness is immediate
    await emitEvent(tx, {
      runId: c.runId,
      taskId: extractTaskId,
      type: "EXTRACT_TASK_CREATED",
      kind: "info",
      actor: ACTOR,
      payload: { researchTaskId: c.taskId, noteArtifactId: parsed.data.noteArtifactId },
    });
    return { extractTaskId };
  });
}
