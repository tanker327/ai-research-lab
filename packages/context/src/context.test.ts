// Ticket 3.1 acceptance (phase-3-plan Session A): builders against real
// Postgres — digest rendering, liveness filtering, subject filtering, budget
// overflow order, loud failure, and the ADR-018 reasoning-exclusion contract.
import {
  createDb,
  deleteRun,
  seedAttempt,
  seedCanonicalClaim,
  seedClaimEvidenceLink,
  seedEvidence,
  seedRawClaim,
  seedRun,
  seedSpec,
  seedTask,
} from "@lab/db";
import { CategorizedError, newId } from "@lab/schemas";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createContextBuilder, estimateTokens } from "./index";

const url = process.env.DATABASE_URL ?? "postgres://lab:lab@localhost:5434/research_lab";
const { db, close } = createDb(url);
const CAPS = [{ name: "web_fetch", description: "fetch a URL and snapshot it" }];

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

interface Seeded {
  runId: string;
  taskId: string;
  attemptId: string;
  claimId: string;
}

// One accepted research task with a supported claim + linked evidence, and a
// contested claim on another subject.
async function seedGraph(): Promise<Seeded> {
  const runId = newId();
  const taskId = newId();
  const attemptId = newId();
  const claimId = newId();
  cleanup.push(runId);
  await seedRun(db, runId, "compare qwen3.6 quantization options");
  await seedTask(db, { id: taskId, runId, status: "DONE", type: "research", title: "discovery" });
  await seedAttempt(db, {
    id: attemptId,
    taskId,
    runId,
    status: "ACCEPTED",
    output: {
      noteArtifactId: newId(),
      sourcesVisited: [],
      selfAssessment: { complete: true, confidence: "high", gaps: ["no FP8 numbers"] },
    },
  });
  await seedCanonicalClaim(db, {
    id: claimId,
    runId,
    subjectKey: "model:qwen3.6-27b",
    predicateKey: "param_count",
    statement: "Qwen3.6-27B has 27B parameters",
  });
  const evidenceId = newId();
  await seedEvidence(db, {
    id: evidenceId,
    runId,
    taskId,
    attemptId,
    excerpt: "The 27B parameter model…",
    sourceClass: "official_docs",
    sourceUrl: "https://example.com/qwen",
    vendorAffiliated: true,
  });
  await seedClaimEvidenceLink(db, { canonicalClaimId: claimId, evidenceId });
  await seedRawClaim(db, {
    id: newId(),
    runId,
    taskId,
    attemptId,
    canonicalClaimId: claimId,
    subjectKey: "model:qwen3.6-27b",
    predicateKey: "param_count",
  });
  const contested = newId();
  await seedCanonicalClaim(db, {
    id: contested,
    runId,
    subjectKey: "model:deepseek-v4",
    predicateKey: "context_window",
    statement: "DeepSeek-V4 context window",
    status: "contested",
    contestNote: "128k (docs) vs 64k (community reports)",
  });
  await seedRawClaim(db, {
    id: newId(),
    runId,
    taskId,
    attemptId,
    canonicalClaimId: contested,
    subjectKey: "model:deepseek-v4",
    predicateKey: "context_window",
  });
  return { runId, taskId, attemptId, claimId };
}

describe("forPlanner", () => {
  it("stage 1: request + capabilities, no digest, no summaries", async () => {
    const { runId } = await seedGraph();
    const builder = createContextBuilder({ db, capabilities: CAPS });
    const input = await builder.forPlanner(runId, 1);
    expect(input.planStage).toBe(1);
    expect(input.userRequest).toContain("qwen3.6");
    expect(input.liveClaimDigest).toBeUndefined();
    expect(input.completedTaskSummaries).toBeUndefined();
    expect(input.availableCapabilities).toEqual(CAPS);
  });

  it("stage 2: spec + deterministic task summaries + claim digest with contested flagged", async () => {
    const { runId } = await seedGraph();
    await seedSpec(db, { id: newId(), runId, objective: "pick a local model" });
    const builder = createContextBuilder({ db, capabilities: CAPS });
    const input = await builder.forPlanner(runId, 2);
    expect(input.specification?.objective).toBe("pick a local model");
    expect(input.completedTaskSummaries).toHaveLength(1);
    expect(input.completedTaskSummaries?.[0]?.summary).toContain("confidence high");
    expect(input.liveClaimDigest).toContain("model:qwen3.6-27b");
    expect(input.liveClaimDigest).toContain("[CONTESTED]");
    expect(input.liveClaimDigest).toContain("128k (docs) vs 64k");
    expect(input.liveClaimDigest).toContain("official_docs");
  });

  it("liveness: superseding the attempt removes its claims from the digest (rule 5)", async () => {
    const { runId, attemptId } = await seedGraph();
    await db.execute(sql`UPDATE attempts SET status = 'SUPERSEDED' WHERE id = ${attemptId}`);
    const builder = createContextBuilder({ db, capabilities: CAPS });
    const input = await builder.forPlanner(runId, 2);
    expect(input.liveClaimDigest).toBeUndefined(); // no live raw claims → no canonical claims
  });

  it("ADR-018: a reasoning artifact never reaches any built input", async () => {
    const { runId, taskId, attemptId } = await seedGraph();
    const marker = "SECRET-REASONING-TRACE-8811";
    await db.execute(sql`
      INSERT INTO artifacts (id, run_id, task_id, attempt_id, type, name, storage_uri, created_by, metadata)
      VALUES (${newId()}, ${runId}, ${taskId}, ${attemptId}, 'reasoning', ${marker},
              'file:///dev/null', 'fixture', ${JSON.stringify({ preview: marker })}::jsonb)`);
    const builder = createContextBuilder({ db, capabilities: CAPS });
    const planner = await builder.forPlanner(runId, 2);
    expect(JSON.stringify(planner)).not.toContain(marker);
    const researchTask = newId();
    await seedTask(db, {
      id: researchTask,
      runId,
      status: "READY",
      type: "research",
      title: "qwen3.6-27b follow-up",
    });
    const researcher = await builder.forResearcher(researchTask);
    expect(JSON.stringify(researcher)).not.toContain(marker);
  });
});

describe("forResearcher", () => {
  it("builds question/strategy/time context and a same-subject digest only", async () => {
    const { runId } = await seedGraph();
    const taskId = newId();
    await seedTask(db, {
      id: taskId,
      runId,
      status: "READY",
      type: "research",
      strategy: "primary_sources",
      title: "t",
      input: {
        researchQuestion: "What quantizations does qwen3.6-27b support?",
        seedUrls: ["https://example.com/qwen"],
        excludedSources: ["reddit.com"],
      },
    });
    const builder = createContextBuilder({
      db,
      capabilities: CAPS,
      now: () => new Date("2026-08-19T00:00:00Z"),
    });
    const input = await builder.forResearcher(taskId);
    expect(input.question).toContain("qwen3.6-27b");
    expect(input.strategy).toBe("primary_sources");
    expect(input.timeContext).toContain("2026-08-19");
    expect(input.seedUrls).toEqual(["https://example.com/qwen"]);
    expect(input.excludedSources).toEqual(["reddit.com"]);
    // subject filter: qwen claim is in, deepseek claim is not
    expect(input.liveEvidenceDigest).toContain("model:qwen3.6-27b");
    expect(input.liveEvidenceDigest).not.toContain("deepseek");
  });

  it("rejects a non-research task", async () => {
    const { runId } = await seedGraph();
    const taskId = newId();
    await seedTask(db, { id: taskId, runId, status: "READY", type: "analyze", title: "t" });
    const builder = createContextBuilder({ db, capabilities: CAPS });
    await expect(builder.forResearcher(taskId)).rejects.toMatchObject({
      category: "PERMANENT_INFRA",
    });
  });
});

describe("budgeting", () => {
  it("degrades the digest before dropping hard content (overflow order §12)", async () => {
    const { runId } = await seedGraph();
    // Measure the full rendering, then set the budget one token short of it:
    // a leaner rung of the ladder must be chosen — never a failure, never a
    // dropped hard constraint.
    const rich = await createContextBuilder({ db, capabilities: CAPS }).forPlanner(runId, 2);
    expect(rich.liveClaimDigest).toContain("The 27B parameter model"); // full has excerpts
    const hard =
      estimateTokens(rich.userRequest) +
      estimateTokens(JSON.stringify(rich.specification ?? {})) +
      estimateTokens(JSON.stringify(rich.completedTaskSummaries));
    const budget = hard + estimateTokens(rich.liveClaimDigest ?? "") - 1;
    const builder = createContextBuilder({ db, capabilities: CAPS, budgets: { planner: budget } });
    const input = await builder.forPlanner(runId, 2);
    expect(input.liveClaimDigest).toBeDefined();
    expect(input.liveClaimDigest).toContain("[CONTESTED]"); // contested never dropped
    expect(input.liveClaimDigest?.length).toBeLessThan(rich.liveClaimDigest?.length ?? 0);
  });

  it("fails loudly when hard content alone exceeds the budget", async () => {
    const { runId } = await seedGraph();
    const builder = createContextBuilder({ db, capabilities: CAPS, budgets: { planner: 10 } });
    await expect(builder.forPlanner(runId, 2)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof CategorizedError &&
        e.category === "QUALITY_FAILURE" &&
        e.message.includes("mis-sized"),
    );
  });
});

describe("forExtractor", () => {
  it("validates the concrete input written at research-accept (ADR-011)", async () => {
    const { runId } = await seedGraph();
    const taskId = newId();
    const note = newId();
    await seedTask(db, {
      id: taskId,
      runId,
      status: "READY",
      type: "extract",
      title: "extract",
      input: {
        noteArtifactId: note,
        sourcesVisited: [{ url: "https://example.com", retrievedAt: "2026-08-19T00:00:00Z" }],
        question: "q",
      },
    });
    const builder = createContextBuilder({ db, capabilities: CAPS });
    const input = await builder.forExtractor(taskId);
    expect(input.noteArtifactId).toBe(note);
    expect(input.sourcesVisited).toHaveLength(1);
  });

  it("SCHEMA_FAILURE on a non-concrete extract input (staged-planning guard)", async () => {
    const { runId } = await seedGraph();
    const taskId = newId();
    await seedTask(db, {
      id: taskId,
      runId,
      status: "READY",
      type: "extract",
      title: "bad",
      input: { noteArtifactId: "{{fill me}}" },
    });
    const builder = createContextBuilder({ db, capabilities: CAPS });
    await expect(builder.forExtractor(taskId)).rejects.toMatchObject({
      category: "SCHEMA_FAILURE",
    });
  });
});
