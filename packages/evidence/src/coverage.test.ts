// CoverageSummary computation (4.1): deterministic facts over live_* views.
// The load-bearing semantics: NULL vendor_affiliated counts as vendor; only
// ACCEPTED attempts' rows are live; a question's claims are DISTINCT canonical
// ids; the key question derives from task lineage, never from agent output.
import {
  createDb,
  deleteRun,
  seedAttempt,
  seedCanonicalClaim,
  seedEvidence,
  seedRawClaim,
  seedRun,
  seedTask,
} from "@lab/db";
import { newId } from "@lab/schemas";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { computeCoverage } from "./coverage";

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

async function seedResearchTask(runId: string, question: string, status = "DONE") {
  const taskId = newId();
  const attemptId = newId();
  await seedTask(db, {
    id: taskId,
    runId,
    status,
    type: "research",
    title: question.slice(0, 40),
    input: { researchQuestion: question },
  });
  await seedAttempt(db, { id: attemptId, taskId, runId, status: "ACCEPTED" });
  return { taskId, attemptId };
}

describe("computeCoverage", () => {
  it("aggregates overall + per-question facts with vendor-NULL counted as vendor", async () => {
    const runId = newId();
    cleanup.push(runId);
    await seedRun(db, runId);
    const a = await seedResearchTask(runId, "What are the transactional DDL limits?");
    const b = await seedResearchTask(runId, "How do other databases compare?", "FAILED");

    // Task A: 3 evidence — non-vendor, vendor, NULL (counts as vendor) → ratio 2/3.
    await seedEvidence(db, {
      id: newId(),
      runId,
      taskId: a.taskId,
      attemptId: a.attemptId,
      excerpt: "e1",
      publisher: "postgresql.org",
      publishedAt: "2024-01-15T00:00:00Z",
      vendorAffiliated: false,
      sourceClass: "official_docs",
      benchmarkOrigin: "tpcc",
    });
    await seedEvidence(db, {
      id: newId(),
      runId,
      taskId: a.taskId,
      attemptId: a.attemptId,
      excerpt: "e2",
      publisher: "vendor.example",
      publishedAt: "2025-06-01T00:00:00Z",
      vendorAffiliated: true,
      sourceClass: "vendor_benchmark",
    });
    await seedEvidence(db, {
      id: newId(),
      runId,
      taskId: a.taskId,
      attemptId: a.attemptId,
      excerpt: "e3",
      publisher: "postgresql.org",
      vendorAffiliated: null,
      sourceClass: "official_docs",
    });

    // Two raw claims → ONE canonical (merged) + one contested canonical on task A.
    const c1 = newId();
    const c2 = newId();
    await seedCanonicalClaim(db, {
      id: c1,
      runId,
      subjectKey: "pg",
      predicateKey: "ddl",
      statement: "s1",
    });
    await seedCanonicalClaim(db, {
      id: c2,
      runId,
      subjectKey: "pg",
      predicateKey: "limits",
      statement: "s2",
      status: "contested",
      contestNote: "sources disagree",
    });
    for (const canonicalClaimId of [c1, c1, c2]) {
      await seedRawClaim(db, {
        id: newId(),
        runId,
        taskId: a.taskId,
        attemptId: a.attemptId,
        canonicalClaimId,
        subjectKey: "pg",
        predicateKey: "x",
      });
    }

    const cov = await computeCoverage(db, runId);
    expect(cov.evidenceCount).toBe(3);
    expect(cov.claimCount).toBe(2);
    expect(cov.contestedCount).toBe(1);
    expect(cov.distinctPublishers).toBe(2);
    expect(cov.distinctOrigins).toBe(1);
    expect(cov.vendorRatio).toBeCloseTo(2 / 3, 5);
    expect(cov.oldestEvidence).toBe("2024-01-15T00:00:00.000Z");
    expect(cov.newestEvidence).toBe("2025-06-01T00:00:00.000Z");
    expect(cov.sourceClassMix).toEqual([
      { sourceClass: "official_docs", count: 2 },
      { sourceClass: "vendor_benchmark", count: 1 },
    ]);

    // Per-question: derived from task lineage; the FAILED task shows up with
    // zero coverage (ADR-010 failure visibility); claims are distinct canonical.
    expect(cov.perQuestion).toHaveLength(2);
    const qa = cov.perQuestion.find((q) => q.question.startsWith("What are"));
    const qb = cov.perQuestion.find((q) => q.question.startsWith("How do"));
    expect(qa).toMatchObject({
      taskStatus: "DONE",
      evidenceCount: 3,
      claimCount: 2,
      distinctPublishers: 2,
    });
    expect(qa?.vendorRatio).toBeCloseTo(2 / 3, 5);
    expect(qb).toMatchObject({ taskStatus: "FAILED", evidenceCount: 0, claimCount: 0 });
    void b;
  });

  it("only ACCEPTED attempts' rows are live; superseded evidence is invisible", async () => {
    const runId = newId();
    cleanup.push(runId);
    await seedRun(db, runId);
    const { taskId } = await seedResearchTask(runId, "Question with a superseded attempt");
    const dead = newId();
    await seedAttempt(db, { id: dead, taskId, runId, attemptNumber: 2, status: "SUPERSEDED" });
    await seedEvidence(db, {
      id: newId(),
      runId,
      taskId,
      attemptId: dead,
      excerpt: "ghost",
      vendorAffiliated: false,
    });

    const cov = await computeCoverage(db, runId);
    expect(cov.evidenceCount).toBe(0);
    expect(cov.vendorRatio).toBe(0); // empty set → 0, not NaN
    expect(cov.oldestEvidence).toBeNull();
    expect(cov.perQuestion[0]?.evidenceCount).toBe(0);
  });

  it("empty run parses cleanly (schema floor, no divide-by-zero)", async () => {
    const runId = newId();
    cleanup.push(runId);
    await seedRun(db, runId);
    const cov = await computeCoverage(db, runId);
    expect(cov).toMatchObject({
      evidenceCount: 0,
      claimCount: 0,
      contestedCount: 0,
      vendorRatio: 0,
      sourceClassMix: [],
      perQuestion: [],
      oldestEvidence: null,
      newestEvidence: null,
    });
  });
});
