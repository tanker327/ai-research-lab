// Ticket 3.5 acceptance: canonicalization against real Postgres + pg_trgm —
// exact dedup, contested values, trigram near-dup with stubbed merge-confirm,
// evidence linking, idempotent re-run, and liveness (dark claims disappear).
import {
  createDb,
  deleteRun,
  seedAttempt,
  seedEvidence,
  seedRawClaim,
  seedRun,
  seedTask,
} from "@lab/db";
import { newId } from "@lab/schemas";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { canonicalizeRun, normalizeKey } from "./canonicalize";

const url = process.env.DATABASE_URL ?? "postgres://lab:lab@localhost:5434/research_lab";
const { db, close } = createDb(url);

const cleanup: string[] = [];
afterEach(async () => {
  while (cleanup.length) {
    const id = cleanup.pop();
    if (id) await deleteRun(db, id);
  }
});
afterAll(async () => {
  await close();
});

async function seedBase() {
  const runId = newId();
  const taskId = newId();
  const attemptId = newId();
  cleanup.push(runId);
  await seedRun(db, runId, "canonicalization test");
  await seedTask(db, { id: taskId, runId, status: "DONE", type: "extract" });
  await seedAttempt(db, { id: attemptId, taskId, runId, status: "ACCEPTED" });
  return { runId, taskId, attemptId };
}

async function rows(q: ReturnType<typeof sql>) {
  return [...(await db.execute(q))] as Record<string, unknown>[];
}

describe("canonicalizeRun", () => {
  it("exact duplicates fold into one supported canonical claim; raw rows point at it", async () => {
    const { runId, taskId, attemptId } = await seedBase();
    for (const v of ["27B", "27B"]) {
      await seedRawClaim(db, {
        id: newId(),
        runId,
        taskId,
        attemptId,
        subjectKey: "model:qwen3.6-27b",
        predicateKey: "param_count",
        valueText: v,
      });
    }
    const result = await canonicalizeRun(db, runId);
    expect(result.canonicalIds).toHaveLength(1);
    const canonical = await rows(
      sql`SELECT id, status, contest_note FROM canonical_claims WHERE run_id = ${runId}`,
    );
    expect(canonical).toHaveLength(1);
    expect(canonical[0]?.status).toBe("supported");
    const raw = await rows(
      sql`SELECT DISTINCT canonical_claim_id FROM raw_claims WHERE run_id = ${runId}`,
    );
    expect(raw).toHaveLength(1);
    expect(raw[0]?.canonical_claim_id).toBe(canonical[0]?.id);
  });

  it("disagreeing values ⇒ contested with a note (the V0.05 contradiction system)", async () => {
    const { runId, taskId, attemptId } = await seedBase();
    for (const v of ["128k", "64k"]) {
      await seedRawClaim(db, {
        id: newId(),
        runId,
        taskId,
        attemptId,
        subjectKey: "model:deepseek-v4",
        predicateKey: "context_window",
        valueText: v,
      });
    }
    const result = await canonicalizeRun(db, runId);
    expect(result.contested).toBe(1);
    const canonical = await rows(
      sql`SELECT status, contest_note FROM canonical_claims WHERE run_id = ${runId}`,
    );
    expect(canonical[0]?.status).toBe("contested");
    expect(String(canonical[0]?.contest_note)).toContain("128k");
    expect(String(canonical[0]?.contest_note)).toContain("64k");
  });

  it("trigram near-dup merges only when the confirmer says yes", async () => {
    const { runId, taskId, attemptId } = await seedBase();
    await seedRawClaim(db, {
      id: newId(),
      runId,
      taskId,
      attemptId,
      subjectKey: "model:qwen3.6-27b",
      predicateKey: "param_count",
      valueText: "27B",
    });
    await canonicalizeRun(db, runId); // establishes the canonical subject

    // A near-duplicate subject spelling arrives from a second task's attempt
    // (one ACCEPTED attempt per task — idx_attempts_one_accepted).
    const task2 = newId();
    const attempt2 = newId();
    await seedTask(db, { id: task2, runId, status: "DONE", type: "extract" });
    await seedAttempt(db, { id: attempt2, taskId: task2, runId, status: "ACCEPTED" });
    await seedRawClaim(db, {
      id: newId(),
      runId,
      taskId: task2,
      attemptId: attempt2,
      subjectKey: "model:qwen-3.6 27b",
      predicateKey: "param_count",
      valueText: "27B",
    });

    // Confirmer says NO → separate canonical rows.
    let r = await canonicalizeRun(db, runId, async (pairs) => pairs.map(() => false));
    expect(r.merged).toBe(0);
    let canonical = await rows(
      sql`SELECT subject_key FROM canonical_claims WHERE run_id = ${runId} ORDER BY subject_key`,
    );
    expect(canonical).toHaveLength(2);

    // Confirmer says YES → folded into the existing subject.
    r = await canonicalizeRun(db, runId, async (pairs) => pairs.map(() => true));
    expect(r.merged).toBe(1);
    canonical = await rows(sql`
      SELECT DISTINCT cc.subject_key FROM canonical_claims cc
      WHERE cc.run_id = ${runId}
        AND EXISTS (SELECT 1 FROM raw_claims rc WHERE rc.canonical_claim_id = cc.id)`);
    expect(canonical).toHaveLength(1); // both spellings converge on one subject
  });

  it("links evidence via metadata.rawClaimIds and is idempotent across re-runs", async () => {
    const { runId, taskId, attemptId } = await seedBase();
    const rawId = newId();
    await seedRawClaim(db, {
      id: rawId,
      runId,
      taskId,
      attemptId,
      subjectKey: "model:qwen3.6-27b",
      predicateKey: "quantization_fp8",
      valueText: "supported",
    });
    await seedEvidence(db, {
      id: newId(),
      runId,
      taskId,
      attemptId,
      excerpt: "supports FP8",
      metadata: { rawClaimIds: [rawId] },
    });
    const first = await canonicalizeRun(db, runId);
    expect(first.linked).toBe(1);
    const second = await canonicalizeRun(db, runId);
    expect(second.canonicalIds).toHaveLength(1);
    const links = await rows(sql`
      SELECT count(*)::int AS n FROM claim_evidence_links cel
      JOIN canonical_claims cc ON cc.id = cel.canonical_claim_id
      WHERE cc.run_id = ${runId}`);
    expect(links[0]?.n).toBe(1); // upsert — no duplicate links
  });

  it("vendor-only benchmark claims are born contested; independent evidence clears them (8.5/D7)", async () => {
    const { runId, taskId, attemptId } = await seedBase();
    // Claim A: benchmark evidence, ALL vendor (null counts as vendor) ⇒ contested.
    const vendorOnly = newId();
    await seedRawClaim(db, {
      id: vendorOnly,
      runId,
      taskId,
      attemptId,
      subjectKey: "model:r1",
      predicateKey: "livecodebench_pass_at1",
      valueText: "65.9",
    });
    await seedEvidence(db, {
      id: newId(),
      runId,
      taskId,
      attemptId,
      excerpt: "we score 65.9",
      vendorAffiliated: true,
      benchmarkOrigin: "LiveCodeBench",
      metadata: { rawClaimIds: [vendorOnly] },
    });
    // Claim B: same shape but one INDEPENDENT evidence row ⇒ supported.
    const confirmed = newId();
    await seedRawClaim(db, {
      id: confirmed,
      runId,
      taskId,
      attemptId,
      subjectKey: "model:o1",
      predicateKey: "livecodebench_pass_at1",
      valueText: "63.4",
    });
    for (const vendor of [true, false]) {
      await seedEvidence(db, {
        id: newId(),
        runId,
        taskId,
        attemptId,
        excerpt: vendor ? "vendor table" : "leaderboard entry",
        vendorAffiliated: vendor,
        benchmarkOrigin: "LiveCodeBench",
        metadata: { rawClaimIds: [confirmed] },
      });
    }
    // Claim C: no benchmark evidence at all (a doc fact) ⇒ untouched even
    // though its only source is vendor-affiliated (the P3 finding stands).
    const docFact = newId();
    await seedRawClaim(db, {
      id: docFact,
      runId,
      taskId,
      attemptId,
      subjectKey: "db:postgresql",
      predicateKey: "transactional_ddl",
      valueText: "yes",
    });
    await seedEvidence(db, {
      id: newId(),
      runId,
      taskId,
      attemptId,
      excerpt: "DDL is transactional",
      vendorAffiliated: true,
      metadata: { rawClaimIds: [docFact] },
    });

    const result = await canonicalizeRun(db, runId);
    expect(result.contested).toBe(1);
    const statuses = await rows(sql`
      SELECT subject_key, status, contest_note FROM canonical_claims
      WHERE run_id = ${runId} ORDER BY subject_key`);
    const byKey = new Map(statuses.map((r) => [r.subject_key, r]));
    expect(byKey.get("db:postgresql")?.status).toBe("supported");
    expect(byKey.get("model:o1")?.status).toBe("supported");
    expect(byKey.get("model:r1")?.status).toBe("contested");
    expect(String(byKey.get("model:r1")?.contest_note)).toContain("vendor-only benchmark");
  });

  it("superseded attempts' claims go dark: live view stops serving the canonical row", async () => {
    const { runId, taskId, attemptId } = await seedBase();
    await seedRawClaim(db, {
      id: newId(),
      runId,
      taskId,
      attemptId,
      subjectKey: "model:x",
      predicateKey: "p",
    });
    await canonicalizeRun(db, runId);
    await db.execute(sql`UPDATE attempts SET status = 'SUPERSEDED' WHERE id = ${attemptId}`);
    const live = await rows(
      sql`SELECT count(*)::int AS n FROM live_canonical_claims WHERE run_id = ${runId}`,
    );
    expect(live[0]?.n).toBe(0);
  });
});

describe("normalizeKey", () => {
  it("lowercases, hyphenates whitespace, strips stray characters", () => {
    expect(normalizeKey(" Model:Qwen3.6 27B ")).toBe("model:qwen3.6-27b");
  });
});
