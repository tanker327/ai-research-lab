// DecisionRecord persistence (rule 10): every retry/cycle/budget verdict is a
// row whose rationale the trace UI renders verbatim.
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../client";

export interface NewDecisionRecord {
  id: string;
  runId: string;
  taskId?: string | null;
  attemptId?: string | null;
  type: string;
  decision: string;
  rationale: string;
  createdBy: string;
  metadata?: Record<string, unknown>;
}

export async function insertDecisionRecord(tx: SqlExecutor, d: NewDecisionRecord): Promise<void> {
  await tx.execute(sql`
    INSERT INTO decision_records (id, run_id, task_id, attempt_id, type, decision,
                                  rationale, created_by, metadata)
    VALUES (${d.id}, ${d.runId}, ${d.taskId ?? null}, ${d.attemptId ?? null}, ${d.type},
            ${d.decision}, ${d.rationale}, ${d.createdBy},
            ${JSON.stringify(d.metadata ?? {})}::jsonb)`);
}
