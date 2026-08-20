// Ticket 3.6 acceptance: pure check functions + the sweep path — a SUCCEEDED
// attempt failing a deterministic check is REJECTED with evaluations rows,
// a DecisionRecord, and a ladder verdict (rule 10). Fake outputs skip checks.
import { createDb, deleteRun, seedAttempt, seedEvidence, seedRun, seedTask } from "@lab/db";
import {
  type AnalysisOutput,
  type ExtractorOutput,
  newId,
  type ResearcherOutput,
} from "@lab/schemas";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { sweepEvaluations } from "../scheduler/evaluate";
import {
  analystPreAcceptChecks,
  extractorPreAcceptChecks,
  researcherPreAcceptChecks,
} from "./index";

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

const GOOD_EXTRACTION: ExtractorOutput = {
  claims: [
    {
      statement: "s",
      subjectKey: "model:x",
      predicateKey: "p",
      valueText: null,
      type: "fact",
      confidence: "high",
      evidenceRefs: [],
    },
  ],
  evidence: [],
  contradictionsNoticed: [],
  unanswered: [],
};

describe("check functions (pure)", () => {
  it("researcher: incomplete + low confidence fails; incomplete + medium passes", () => {
    const base: ResearcherOutput = {
      noteArtifactId: newId(),
      sourcesVisited: [],
      selfAssessment: { complete: false, confidence: "low", gaps: ["no data"] },
    };
    expect(researcherPreAcceptChecks(base)[0]?.check).toBe("check:self_assessment");
    base.selfAssessment.confidence = "medium";
    expect(researcherPreAcceptChecks(base)).toHaveLength(0);
  });

  it("extractor: min-evidence, all-vendor, and zero-claims each fail with readable reasons", () => {
    const failures = extractorPreAcceptChecks(
      { ...GOOD_EXTRACTION, claims: [] },
      { evidenceCount: 2, nonVendorCount: 0 },
      3,
    );
    expect(failures.map((f) => f.check).sort()).toEqual([
      "check:min_claims",
      "check:min_evidence",
      "check:non_vendor",
    ]);
    expect(failures.find((f) => f.check === "check:non_vendor")?.severity).toBe("warn");
    expect(failures.filter((f) => f.severity === "reject")).toHaveLength(2);
    const ok = extractorPreAcceptChecks(
      GOOD_EXTRACTION,
      { evidenceCount: 3, nonVendorCount: 1 },
      3,
    );
    expect(ok).toHaveLength(0);
  });
});

describe("checks in the evaluation sweep", () => {
  async function seedExtractCandidate(evidence: Array<{ vendor: boolean | null }>) {
    const runId = newId();
    const taskId = newId();
    const attemptId = newId();
    cleanup.push(runId);
    await seedRun(db, runId, "checks test");
    await seedTask(db, { id: taskId, runId, status: "EVALUATING", type: "extract", title: "x" });
    await seedAttempt(db, {
      id: attemptId,
      taskId,
      runId,
      status: "SUCCEEDED",
      output: GOOD_EXTRACTION as unknown as Record<string, unknown>,
    });
    for (const e of evidence) {
      await seedEvidence(db, {
        id: newId(),
        runId,
        taskId,
        attemptId,
        excerpt: "e",
        vendorAffiliated: e.vendor,
      });
    }
    return { runId, taskId, attemptId };
  }

  it("thin extraction is rejected: evaluations rows + decision + retry (never accepted)", async () => {
    const { runId, taskId, attemptId } = await seedExtractCandidate([{ vendor: true }]);
    const result = await sweepEvaluations(db);
    expect(result.retried).toContain(taskId);
    expect(result.accepted).not.toContain(taskId);

    const attempt = [
      ...(await db.execute(sql`SELECT status FROM attempts WHERE id = ${attemptId}`)),
    ];
    expect(attempt[0]?.status).toBe("REJECTED");
    const evals = [
      ...(await db.execute(sql`
      SELECT evaluator_name, decision FROM evaluations WHERE run_id = ${runId} ORDER BY evaluator_name`)),
    ];
    expect(evals.map((e) => e.evaluator_name)).toEqual(["check:min_evidence"]);
    const decisions = [
      ...(await db.execute(sql`
      SELECT type, rationale FROM decision_records WHERE task_id = ${taskId}`)),
    ];
    expect(decisions[0]?.type).toBe("deterministic_check");
    expect(String(decisions[0]?.rationale)).toContain("≥3 live evidence");
  });

  it("all-vendor evidence is advisory: WARN evaluation + event, attempt still accepted", async () => {
    const { runId, taskId } = await seedExtractCandidate([
      { vendor: true },
      { vendor: true },
      { vendor: null },
    ]);
    const result = await sweepEvaluations(db);
    expect(result.accepted).toContain(taskId);
    const evals = [
      ...(await db.execute(sql`
      SELECT evaluator_name, decision FROM evaluations WHERE run_id = ${runId}`)),
    ];
    expect(evals[0]).toMatchObject({ evaluator_name: "check:non_vendor", decision: "WARN" });
    const events = [
      ...(await db.execute(sql`
      SELECT kind FROM events WHERE run_id = ${runId} AND type = 'CHECK_WARNING'`)),
    ];
    expect(events[0]?.kind).toBe("warn");
  });

  it("healthy extraction passes the checks and is accepted", async () => {
    const { taskId } = await seedExtractCandidate([
      { vendor: false },
      { vendor: true },
      { vendor: null },
    ]);
    const result = await sweepEvaluations(db);
    expect(result.accepted).toContain(taskId);
  });

  it("fake outputs skip checks entirely (phase-1 machinery unaffected)", async () => {
    const runId = newId();
    const taskId = newId();
    cleanup.push(runId);
    await seedRun(db, runId);
    await seedTask(db, { id: taskId, runId, status: "EVALUATING", type: "extract", title: "f" });
    await seedAttempt(db, { id: newId(), taskId, runId, status: "SUCCEEDED", output: null });
    const result = await sweepEvaluations(db);
    expect(result.accepted).toContain(taskId);
  });
});

describe("analyst check (pure)", () => {
  const ANALYSIS: AnalysisOutput = {
    findings: [
      { statement: "PG supports transactional DDL", canonicalClaimIds: ["c1"], implication: null },
      {
        statement: "limits exist",
        canonicalClaimIds: ["c2", "c1"],
        implication: "plan migrations",
      },
    ],
    comparisons: [{ topic: "vs MySQL", statement: "PG stronger", canonicalClaimIds: ["c2"] }],
    unresolvedQuestions: [],
    confidenceNote: "solid",
  };

  it("passes when every cited id is live", () => {
    expect(analystPreAcceptChecks(ANALYSIS, new Set(["c1", "c2"]))).toHaveLength(0);
  });

  it("rejects unknown ids (findings AND comparisons), listing them", () => {
    const failures = analystPreAcceptChecks(ANALYSIS, new Set(["c1"]));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ check: "check:findings_cite_claims", severity: "reject" });
    expect(failures[0]?.reason).toContain("c2");
  });
});
