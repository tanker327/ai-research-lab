// Canonicalization reads/writes (ticket 3.5, design §10). Raw-claim reads go
// through live_raw_claims ONLY — a canonical row is a pure function of the
// live raw set (database-schema §6 contract). Trigram candidate search uses
// idx_canonical_subject_trgm (pg_trgm, enabled in 0000_init).
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../client";

export interface LiveRawClaimRow {
  id: string;
  runId: string;
  attemptId: string;
  canonicalClaimId: string | null;
  statement: string;
  subjectKey: string;
  predicateKey: string;
  valueText: string | null;
  type: string;
  confidence: string | null;
}

export async function selectLiveRawClaims(
  tx: SqlExecutor,
  runId: string,
): Promise<LiveRawClaimRow[]> {
  const rows = await tx.execute(sql`
    SELECT id, run_id, attempt_id, canonical_claim_id, statement, subject_key, predicate_key,
           value_text, type, confidence
    FROM live_raw_claims WHERE run_id = ${runId}
    ORDER BY created_at ASC`);
  return [...rows].map((r) => ({
    id: r.id as string,
    runId: r.run_id as string,
    attemptId: r.attempt_id as string,
    canonicalClaimId: (r.canonical_claim_id as string | null) ?? null,
    statement: r.statement as string,
    subjectKey: r.subject_key as string,
    predicateKey: r.predicate_key as string,
    valueText: (r.value_text as string | null) ?? null,
    type: r.type as string,
    confidence: (r.confidence as string | null) ?? null,
  }));
}

export interface CanonicalClaimKeyRow {
  id: string;
  subjectKey: string;
  predicateKey: string;
  statement: string;
}

// Trigram candidates: existing canonical claims for the SAME predicate whose
// subject is similar but not identical ('qwen-3.6 27b' vs 'qwen3.6-27b').
export async function selectTrgmCandidates(
  tx: SqlExecutor,
  runId: string,
  subjectKey: string,
  predicateKey: string,
  threshold: number,
): Promise<CanonicalClaimKeyRow[]> {
  const rows = await tx.execute(sql`
    SELECT id, subject_key, predicate_key, statement FROM canonical_claims
    WHERE run_id = ${runId} AND predicate_key = ${predicateKey}
      AND subject_key != ${subjectKey}
      AND similarity(subject_key, ${subjectKey}) >= ${threshold}
    ORDER BY similarity(subject_key, ${subjectKey}) DESC
    LIMIT 5`);
  return [...rows].map((r) => ({
    id: r.id as string,
    subjectKey: r.subject_key as string,
    predicateKey: r.predicate_key as string,
    statement: r.statement as string,
  }));
}

export async function upsertCanonicalClaim(
  tx: SqlExecutor,
  c: {
    id: string;
    runId: string;
    subjectKey: string;
    predicateKey: string;
    statement: string;
    type: string;
  },
): Promise<string> {
  const rows = await tx.execute(sql`
    INSERT INTO canonical_claims (id, run_id, subject_key, predicate_key, statement, type)
    VALUES (${c.id}, ${c.runId}, ${c.subjectKey}, ${c.predicateKey}, ${c.statement}, ${c.type})
    ON CONFLICT (run_id, subject_key, predicate_key)
    DO UPDATE SET updated_at = now()
    RETURNING id`);
  return [...rows][0]?.id as string;
}

export async function updateCanonicalStatus(
  tx: SqlExecutor,
  id: string,
  status: string,
  contestNote: string | null,
  statement: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE canonical_claims
    SET status = ${status}, contest_note = ${contestNote}, statement = ${statement},
        updated_at = now()
    WHERE id = ${id}`);
}

export async function setRawClaimCanonical(
  tx: SqlExecutor,
  rawClaimId: string,
  canonicalClaimId: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE raw_claims SET canonical_claim_id = ${canonicalClaimId} WHERE id = ${rawClaimId}`);
}

export async function upsertClaimEvidenceLink(
  tx: SqlExecutor,
  canonicalClaimId: string,
  evidenceId: string,
  relation: string,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO claim_evidence_links (canonical_claim_id, evidence_id, relation)
    VALUES (${canonicalClaimId}, ${evidenceId}, ${relation})
    ON CONFLICT (canonical_claim_id, evidence_id) DO NOTHING`);
}

export interface LiveEvidenceLinkSource {
  id: string;
  rawClaimIds: string[];
  // Vendor-independence facts for the canonicalizer's benchmark contest rule
  // (8.5/D7): NULL affiliation counts as vendor (existing safety rule).
  vendorAffiliated: boolean | null;
  benchmarkOrigin: string | null;
}

// Live evidence rows carrying the extractor's claim↔evidence mapping
// (metadata.rawClaimIds, written in 3.4).
export async function selectLiveEvidenceLinkSources(
  tx: SqlExecutor,
  runId: string,
): Promise<LiveEvidenceLinkSource[]> {
  const rows = await tx.execute(sql`
    SELECT id, metadata, vendor_affiliated, benchmark_origin FROM live_evidence
    WHERE run_id = ${runId} AND metadata ? 'rawClaimIds'`);
  return [...rows].map((r) => ({
    id: r.id as string,
    rawClaimIds: ((r.metadata as Record<string, unknown>).rawClaimIds as string[]) ?? [],
    vendorAffiliated: (r.vendor_affiliated as boolean | null) ?? null,
    benchmarkOrigin: (r.benchmark_origin as string | null) ?? null,
  }));
}
