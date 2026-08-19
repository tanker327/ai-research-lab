// Reasoning persistence (R11): model "thinking" is stored as a
// type='reasoning' artifact — display/debug only, never selected into agent
// context (ADR-018; enforced again in packages/context in Phase 3).
import type { ArtifactStore, Db } from "@lab/db";
import { type ModelCallContext, newId } from "@lab/schemas";

export function createArtifactReasoningSink(store: ArtifactStore, db: Db) {
  return async (ctx: ModelCallContext, reasoning: string): Promise<string> => {
    const saved = await store.save(db, {
      id: newId(),
      runId: ctx.runId,
      taskId: ctx.taskId ?? null,
      attemptId: ctx.attemptId,
      type: "reasoning",
      name: `reasoning ${ctx.createdBy}`,
      content: reasoning,
      createdBy: ctx.createdBy,
    });
    return saved.id;
  };
}
