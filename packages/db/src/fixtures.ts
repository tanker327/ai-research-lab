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

// Phase-3 fixtures: seed the claim/evidence graph the Context Builder reads
// (through live_* views — hence the attempt status knob).
export async function seedAttempt(
  tx: SqlExecutor,
  a: {
    id: string;
    taskId: string;
    runId: string;
    attemptNumber?: number;
    status?: string;
    output?: Record<string, unknown> | null;
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO attempts (id, task_id, run_id, attempt_number, status, agent_name,
                          agent_version, output)
    VALUES (${a.id}, ${a.taskId}, ${a.runId}, ${a.attemptNumber ?? 1},
            ${a.status ?? "ACCEPTED"}, 'fixture', 'v1',
            ${a.output ? JSON.stringify(a.output) : null}::jsonb)`);
}

export async function seedSpec(
  tx: SqlExecutor,
  s: {
    id: string;
    runId: string;
    version?: number;
    objective: string;
    successCriteria?: string[];
    keyQuestions?: string[];
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO research_specs (id, run_id, version, objective, success_criteria, key_questions)
    VALUES (${s.id}, ${s.runId}, ${s.version ?? 1}, ${s.objective},
            ${JSON.stringify(s.successCriteria ?? [])}::jsonb,
            ${JSON.stringify(s.keyQuestions ?? [])}::jsonb)`);
}

export async function seedCanonicalClaim(
  tx: SqlExecutor,
  c: {
    id: string;
    runId: string;
    subjectKey: string;
    predicateKey: string;
    statement: string;
    type?: string;
    status?: string;
    contestNote?: string | null;
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO canonical_claims (id, run_id, subject_key, predicate_key, statement, type,
                                  status, contest_note)
    VALUES (${c.id}, ${c.runId}, ${c.subjectKey}, ${c.predicateKey}, ${c.statement},
            ${c.type ?? "fact"}, ${c.status ?? "supported"}, ${c.contestNote ?? null})`);
}

export async function seedRawClaim(
  tx: SqlExecutor,
  c: {
    id: string;
    runId: string;
    taskId: string;
    attemptId: string;
    canonicalClaimId?: string | null;
    statement?: string;
    subjectKey: string;
    predicateKey: string;
    valueText?: string | null;
    type?: string;
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO raw_claims (id, run_id, task_id, attempt_id, canonical_claim_id, statement,
                            subject_key, predicate_key, value_text, type, created_by_agent)
    VALUES (${c.id}, ${c.runId}, ${c.taskId}, ${c.attemptId}, ${c.canonicalClaimId ?? null},
            ${c.statement ?? `${c.subjectKey} ${c.predicateKey}`}, ${c.subjectKey},
            ${c.predicateKey}, ${c.valueText ?? null}, ${c.type ?? "fact"}, 'fixture')`);
}

export async function seedEvidence(
  tx: SqlExecutor,
  e: {
    id: string;
    runId: string;
    taskId: string;
    attemptId: string;
    excerpt: string;
    sourceClass?: string;
    sourceUrl?: string | null;
    vendorAffiliated?: boolean | null;
    benchmarkOrigin?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO evidence (id, run_id, task_id, attempt_id, source_class, source_url,
                          vendor_affiliated, benchmark_origin, excerpt, metadata)
    VALUES (${e.id}, ${e.runId}, ${e.taskId}, ${e.attemptId}, ${e.sourceClass ?? "community"},
            ${e.sourceUrl ?? null}, ${e.vendorAffiliated ?? null},
            ${e.benchmarkOrigin ?? null}, ${e.excerpt}, ${JSON.stringify(e.metadata ?? {})}::jsonb)`);
}

export async function seedClaimEvidenceLink(
  tx: SqlExecutor,
  l: { canonicalClaimId: string; evidenceId: string; relation?: string },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO claim_evidence_links (canonical_claim_id, evidence_id, relation)
    VALUES (${l.canonicalClaimId}, ${l.evidenceId}, ${l.relation ?? "supports"})`);
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
