// Extractor side-effect writes (ticket 3.4). Every row carries attempt_id
// (rule 5, ADR-014): the rows exist immediately but only become live when the
// attempt is accepted, and go dark when it is superseded.
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../client";

export async function insertEvidenceRow(
  tx: SqlExecutor,
  e: {
    id: string;
    runId: string;
    taskId: string;
    attemptId: string;
    sourceClass: string;
    sourceUrl: string | null;
    publisher: string | null;
    publishedAt: string | null;
    vendorAffiliated: boolean | null;
    benchmarkOrigin: string | null;
    excerpt: string;
    artifactId: string | null;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  // postgres-js rejects Date objects through the raw template; pass ISO text
  // (PG casts to timestamptz) and drop unparseable model-supplied dates.
  const publishedAtMs = e.publishedAt ? Date.parse(e.publishedAt) : Number.NaN;
  const publishedAt = Number.isNaN(publishedAtMs) ? null : new Date(publishedAtMs).toISOString();
  await tx.execute(sql`
    INSERT INTO evidence (id, run_id, task_id, attempt_id, source_class, source_url, publisher,
                          published_at, vendor_affiliated, benchmark_origin, excerpt,
                          artifact_id, metadata)
    VALUES (${e.id}, ${e.runId}, ${e.taskId}, ${e.attemptId}, ${e.sourceClass}, ${e.sourceUrl},
            ${e.publisher}, ${publishedAt}::timestamptz,
            ${e.vendorAffiliated}, ${e.benchmarkOrigin}, ${e.excerpt}, ${e.artifactId},
            ${JSON.stringify(e.metadata)}::jsonb)`);
}

export async function insertRawClaimRow(
  tx: SqlExecutor,
  c: {
    id: string;
    runId: string;
    taskId: string;
    attemptId: string;
    statement: string;
    subjectKey: string;
    predicateKey: string;
    valueText: string | null;
    type: string;
    confidence: string;
    createdByAgent: string;
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO raw_claims (id, run_id, task_id, attempt_id, statement, subject_key,
                            predicate_key, value_text, type, confidence, created_by_agent)
    VALUES (${c.id}, ${c.runId}, ${c.taskId}, ${c.attemptId}, ${c.statement}, ${c.subjectKey},
            ${c.predicateKey}, ${c.valueText}, ${c.type}, ${c.confidence}, ${c.createdByAgent})`);
}
