// Smoke tests for migration 0001 against real Postgres (CLAUDE.md testing rules:
// correctness IS SQL semantics — partial unique indexes, views, CHECKs).
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";

// UUIDv7 helper arrives with ticket 0.4 (@lab/schemas); random v4 ids are fine for tests.
const sql = postgres(
  process.env.DATABASE_URL ?? "postgres://lab:lab@localhost:5434/research_lab",
);

const runId = randomUUID();
const taskId = randomUUID();

afterAll(async () => {
  await sql`DELETE FROM research_runs WHERE id = ${runId}`; // cascades everything
  await sql.end();
});

describe("migration 0001", () => {
  it("creates all tables and liveness views", async () => {
    const tables = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
    const names = tables.map((r) => r.table_name);
    for (const t of [
      "research_runs", "research_specs", "plan_stages", "research_tasks",
      "task_dependencies", "attempts", "artifacts", "evidence", "raw_claims",
      "canonical_claims", "claim_evidence_links", "evaluations",
      "decision_records", "events", "model_calls", "tool_calls", "human_checkpoints",
    ]) {
      expect(names).toContain(t);
    }
    const views = await sql`
      SELECT table_name FROM information_schema.views WHERE table_schema = 'public'`;
    expect(views.map((r) => r.table_name).sort()).toEqual([
      "live_canonical_claims", "live_claim_evidence", "live_evidence", "live_raw_claims",
    ]);
  });

  it("enforces at most one ACCEPTED attempt per task (idx_attempts_one_accepted)", async () => {
    await sql`INSERT INTO research_runs (id, user_request) VALUES (${runId}, 'test')`;
    await sql`INSERT INTO research_tasks (id, run_id, type, title, agent_role)
              VALUES (${taskId}, ${runId}, 'research', 't', 'researcher')`;
    const mkAttempt = (n: number, status: string) =>
      sql`INSERT INTO attempts (id, task_id, run_id, attempt_number, status, agent_name, agent_version)
          VALUES (${randomUUID()}, ${taskId}, ${runId}, ${n}, ${status}, 'researcher', 'v1')`;
    await mkAttempt(1, "ACCEPTED");
    await mkAttempt(2, "SUPERSEDED"); // non-ACCEPTED rows are unlimited
    await expect(mkAttempt(3, "ACCEPTED")).rejects.toThrow(/idx_attempts_one_accepted/);
  });

  it("liveness views expose only ACCEPTED attempts' side effects (ADR-014)", async () => {
    const accepted = await sql`SELECT id FROM attempts
      WHERE task_id = ${taskId} AND status = 'ACCEPTED'`;
    const superseded = await sql`SELECT id FROM attempts
      WHERE task_id = ${taskId} AND status = 'SUPERSEDED'`;
    const mkEvidence = (attemptId: string) =>
      sql`INSERT INTO evidence (id, run_id, task_id, attempt_id, source_class, excerpt)
          VALUES (${randomUUID()}, ${runId}, ${taskId}, ${attemptId}, 'paper', 'x')`;
    await mkEvidence(accepted[0]?.id);
    await mkEvidence(superseded[0]?.id);
    const live = await sql`SELECT attempt_id FROM live_evidence WHERE run_id = ${runId}`;
    expect(live).toHaveLength(1);
    expect(live[0]?.attempt_id).toBe(accepted[0]?.id);
  });

  it("rejects out-of-vocabulary enum values via CHECK constraints", async () => {
    await expect(
      sql`INSERT INTO research_tasks (id, run_id, type, title, agent_role)
          VALUES (${randomUUID()}, ${runId}, 'bogus', 't', 'r')`,
    ).rejects.toThrow(/check/i);
  });
});
