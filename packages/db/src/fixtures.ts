// Phase-1 fake machinery: seeds for concurrency tests and the side-effect
// write used by the worker's fake handlers (phase-1-plan Session B). Real
// evidence writes arrive with the Researcher pipeline in Phase 3 — nothing
// outside tests, fake handlers, and the phase gate may import this module.
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "./client";

export async function seedRun(
  tx: SqlExecutor,
  id: string,
  userRequest = "fixture run",
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO research_runs (id, user_request) VALUES (${id}, ${userRequest})`);
}

export interface SeedTask {
  id: string;
  runId: string;
  status?: string;
  type?: string;
  title?: string;
  priority?: number;
  strategy?: string | null;
  maxAttempts?: number;
  input?: Record<string, unknown>;
}

export async function seedTask(tx: SqlExecutor, t: SeedTask): Promise<void> {
  await tx.execute(sql`
    INSERT INTO research_tasks (id, run_id, status, type, title, priority, strategy,
                                max_attempts, input, agent_role)
    VALUES (${t.id}, ${t.runId}, ${t.status ?? "READY"}, ${t.type ?? "research"},
            ${t.title ?? "fixture task"}, ${t.priority ?? 50}, ${t.strategy ?? null},
            ${t.maxAttempts ?? 3}, ${JSON.stringify(t.input ?? {})}::jsonb, 'fake')`);
}

export async function deleteRun(tx: SqlExecutor, id: string): Promise<void> {
  await tx.execute(sql`DELETE FROM research_runs WHERE id = ${id}`); // cascades
}

// The fake side-effect row: an evidence row owned by the writing attempt
// (rule 5). The phase gate counts live_evidence rows to prove supersede
// semantics — a re-run after SIGKILL must not produce duplicate live rows.
export async function insertFakeEvidence(
  tx: SqlExecutor,
  e: { id: string; runId: string; taskId: string; attemptId: string; excerpt: string },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO evidence (id, run_id, task_id, attempt_id, source_class, excerpt)
    VALUES (${e.id}, ${e.runId}, ${e.taskId}, ${e.attemptId}, 'community', ${e.excerpt})`);
}

export async function seedDependency(
  tx: SqlExecutor,
  taskId: string,
  dependsOnTaskId: string,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO task_dependencies (task_id, depends_on_task_id)
    VALUES (${taskId}, ${dependsOnTaskId})`);
}
