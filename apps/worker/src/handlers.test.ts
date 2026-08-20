// Direct tests for the fake handler registry — previously covered only
// through the gate. A handler either returns (SUCCEEDED) or throws a
// CategorizedError (FAILED with that category); input is Zod-validated per
// rule 7.
import { createDb, deleteRun, seedRun, seedTask } from "@lab/db";
import { CategorizedError, newId, TaskType } from "@lab/schemas";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createHandlerRegistry } from "./handlers";

const url = process.env.DATABASE_URL ?? "postgres://lab:lab@localhost:5434/research_lab";
const { db, sql, close } = createDb(url);
const registry = createHandlerRegistry();
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

// A minimal ClaimedWork with real FK rows (side_effect writes evidence).
async function seedWork(input: Record<string, unknown>) {
  const runId = newId();
  const taskId = newId();
  const attemptId = newId();
  cleanup.push(runId);
  await seedRun(db, runId);
  await seedTask(db, { id: taskId, runId, status: "RUNNING", input });
  await sql`INSERT INTO attempts (id, task_id, run_id, attempt_number, status, agent_name, agent_version)
            VALUES (${attemptId}, ${taskId}, ${runId}, 1, 'RUNNING', 'fake', 'v1')`;
  return {
    task: {
      id: taskId,
      runId,
      type: "research" as const,
      title: "t",
      priority: 50,
      agentRole: "fake",
      agentVersion: "v1",
      modelTier: null,
      strategy: null,
      input,
      maxAttempts: 3,
      attemptCount: 1,
    },
    attempt: { id: attemptId, attemptNumber: 1 },
  };
}

describe("fake handler registry", () => {
  it("registers a handler for every TaskType", () => {
    for (const type of TaskType.options) expect(registry[type]).toBeTypeOf("function");
  });

  it("sleep behavior completes", async () => {
    const work = await seedWork({ fake: { behavior: "sleep", ms: 5 } });
    await expect(registry.research(db, work)).resolves.toBeUndefined();
  });

  it("empty input defaults to a short sleep (schema default)", async () => {
    const work = await seedWork({});
    await expect(registry.research(db, work)).resolves.toBeUndefined();
  });

  it("fail behavior throws the configured CategorizedError", async () => {
    const work = await seedWork({
      fake: { behavior: "fail", category: "TOOL_FAILURE", message: "boom" },
    });
    const err = await registry.research(db, work).catch((e) => e);
    expect(err).toBeInstanceOf(CategorizedError);
    expect(err).toMatchObject({ category: "TOOL_FAILURE", message: "boom" });
  });

  it("malformed fake input is a SCHEMA_FAILURE (rule 7 — never best-effort)", async () => {
    const work = await seedWork({ fake: { behavior: "explode" } });
    const err = await registry.research(db, work).catch((e) => e);
    expect(err).toBeInstanceOf(CategorizedError);
    expect((err as CategorizedError).category).toBe("SCHEMA_FAILURE");
  });

  it("side_effect writes an evidence row owned by the attempt (rule 5)", async () => {
    const work = await seedWork({ fake: { behavior: "side_effect", excerpt: "handler-test" } });
    await registry.research(db, work);
    const rows =
      await sql`SELECT attempt_id, excerpt FROM evidence WHERE task_id = ${work.task.id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ attempt_id: work.attempt.id, excerpt: "handler-test" });
  });
});

// ---- Planner dispatch (ticket 3.2): contract test with a stubbed hub ----
import { createContextBuilder } from "@lab/context";
import { loadConfig } from "@lab/core";
import { createArtifactStore } from "@lab/db";
import { createModelClient } from "@lab/model";
import { type PlannerOutput, PlannerOutput as PlannerOutputSchema } from "@lab/schemas";
import { createToolRegistry, webFetchTool } from "@lab/tools";

const PLAN: PlannerOutput = {
  specification: {
    objective: "o",
    scope: [],
    exclusions: [],
    constraints: [],
    successCriteria: ["s"],
    keyQuestions: ["k"],
  },
  clarificationsAssumed: [],
  planDelta: {
    addTasks: [],
    cancelTaskIds: [],
    supersedeTaskIds: [],
    rationale: "empty stage",
  },
};

function stubHubFetch(json: unknown): typeof globalThis.fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        id: "c1",
        object: "chat.completion",
        created: 1,
        model: "local-llm/resolved",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: JSON.stringify(json) },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof globalThis.fetch;
}

function agentDeps(fetchImpl: typeof globalThis.fetch) {
  // PLANNER_TIER pinned off-frontier so the D3 downgrade-warn path stays exercised.
  const config = loadConfig({ DATABASE_URL: url, PLANNER_TIER: "strong_local" });
  const artifacts = createArtifactStore("./data/test-artifacts");
  return {
    config,
    model: createModelClient({
      baseUrl: config.AIHUB_BASE_URL,
      serviceName: config.AIHUB_SERVICE_NAME,
      db,
      fetch: fetchImpl,
    }),
    tools: createToolRegistry({ db, store: artifacts, fetchImpl }, [webFetchTool]),
    artifacts,
    context: createContextBuilder({
      db,
      capabilities: [{ name: "web_fetch", description: "fetch" }],
    }),
  };
}

describe("planner dispatch (3.2)", () => {
  it("builds context, persists input+output verbatim, emits the D3 tier warn event", async () => {
    const registry3 = createHandlerRegistry(agentDeps(stubHubFetch(PLAN)));
    const work = await seedWork({ planStage: 1 });
    await sql`UPDATE research_tasks SET type = 'plan', agent_role = 'planner' WHERE id = ${work.task.id}`;

    await registry3.plan(db, { ...work, task: { ...work.task, type: "plan" } });

    const attempt = await sql`SELECT input, output FROM attempts WHERE id = ${work.attempt.id}`;
    const input = attempt[0]?.input as Record<string, unknown>;
    expect(input.planStage).toBe(1); // R12: the built PlannerInput, not task.input
    expect(input.availableCapabilities).toBeDefined();
    expect(PlannerOutputSchema.parse(attempt[0]?.output)).toEqual(PLAN);

    const events = await sql`
      SELECT kind FROM events WHERE run_id = ${work.task.runId} AND type = 'PLANNER_TIER_DOWNGRADED'`;
    expect(events[0]?.kind).toBe("warn"); // D3: loud, never silent
  });

  it("malformed model JSON is a SCHEMA_FAILURE (rule 7)", async () => {
    const registry3 = createHandlerRegistry(agentDeps(stubHubFetch({ garbage: true })));
    const work = await seedWork({ planStage: 1 });
    await expect(
      registry3.plan(db, { ...work, task: { ...work.task, type: "plan" } }),
    ).rejects.toMatchObject({ category: "SCHEMA_FAILURE" });
  });

  it("fake-input plan tasks still take the fake path (gate:p1 compatibility)", async () => {
    const registry3 = createHandlerRegistry(agentDeps(stubHubFetch(PLAN)));
    const work = await seedWork({ fake: { behavior: "sleep", ms: 5 } });
    await registry3.plan(db, { ...work, task: { ...work.task, type: "plan" } });
    const attempt = await sql`SELECT output FROM attempts WHERE id = ${work.attempt.id}`;
    expect(attempt[0]?.output).toBeNull(); // fake path — no model call, no output
  });
});

// ---- Researcher dispatch (ticket 3.3): stubbed hub + stubbed pages ----
describe("researcher dispatch (3.3)", () => {
  it("runs the loop, saves the note, assembles sourcesVisited from tool_calls (mechanical)", async () => {
    // The one fetch stub serves both the hub (chat completions) and pages.
    let modelCall = 0;
    const steps = [
      { action: "fetch", url: "https://docs.example.com/q", startChar: null, why: "official docs" },
      {
        action: "finish",
        note: `# Question\nq\n# Findings\n${"Quoted excerpt from the official documentation follows, with source URL noted. ".repeat(10)}`,
        selfAssessment: { complete: true, confidence: "medium", gaps: ["no benchmarks"] },
      },
    ];
    const fetchImpl = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const target = String(input);
      if (target.includes("chat/completions")) {
        const step = steps[Math.min(modelCall, steps.length - 1)];
        modelCall++;
        return new Response(
          JSON.stringify({
            id: "c1",
            object: "chat.completion",
            created: 1,
            model: "local-llm/resolved",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: JSON.stringify(step) },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("<p>Official quantization docs</p>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof globalThis.fetch;

    const registry3 = createHandlerRegistry(agentDeps(fetchImpl));
    const work = await seedWork({ researchQuestion: "What quantizations exist?" });
    await sql`UPDATE research_tasks SET agent_role = 'researcher', strategy = 'primary_sources'
              WHERE id = ${work.task.id}`;

    await registry3.research(db, work);

    const attempt = await sql`SELECT input, output FROM attempts WHERE id = ${work.attempt.id}`;
    const input = attempt[0]?.input as Record<string, unknown>;
    expect(input.question).toBe("What quantizations exist?"); // R12: built ResearcherInput
    const output = attempt[0]?.output as {
      noteArtifactId: string;
      sourcesVisited: Array<{ url: string; snapshotArtifactId: string | null }>;
    };
    expect(output.noteArtifactId).toBeTruthy();
    expect(output.sourcesVisited).toHaveLength(1);
    expect(output.sourcesVisited[0]?.url).toBe("https://docs.example.com/q");
    expect(output.sourcesVisited[0]?.snapshotArtifactId).not.toBeNull();

    const note = await sql`SELECT type FROM artifacts WHERE id = ${output.noteArtifactId}`;
    expect(note[0]?.type).toBe("research_note");
  });
});

// ---- Extractor dispatch (ticket 3.4): stubbed hub, real side-effect rows ----
describe("extractor dispatch (3.4)", () => {
  async function seedExtractWork(deps: ReturnType<typeof agentDeps>) {
    const work = await seedWork({});
    // A real note artifact the handler's readArtifact can load.
    const saved = await deps.artifacts.save(db, {
      id: newId(),
      runId: work.task.runId,
      taskId: work.task.id,
      attemptId: work.attempt.id,
      type: "research_note",
      name: "note",
      content: "# Findings\nQwen3.6-27B supports FP8 per official docs.",
      createdBy: "test",
    });
    const input = {
      noteArtifactId: saved.id,
      sourcesVisited: [{ url: "https://docs.example.com", retrievedAt: "2026-08-19T00:00:00Z" }],
      question: "quantizations?",
    };
    await sql`UPDATE research_tasks SET type = 'extract', agent_role = 'extractor',
              input = ${JSON.stringify(input)}::jsonb WHERE id = ${work.task.id}`;
    return { ...work, task: { ...work.task, type: "extract" as const, input } };
  }

  const EXTRACTION = {
    claims: [
      {
        statement: "Qwen3.6-27B supports FP8 quantization",
        subjectKey: "model:qwen3.6-27b",
        predicateKey: "quantization_fp8",
        valueText: "supported",
        type: "fact",
        confidence: "high",
        evidenceRefs: [0],
      },
    ],
    evidence: [
      {
        excerpt: "Qwen3.6-27B supports FP8 per official docs.",
        sourceUrl: "https://docs.example.com",
        sourceClass: "official_docs",
        publisher: null,
        publishedAt: null,
        vendorAffiliated: true,
        benchmarkOrigin: null,
      },
    ],
    contradictionsNoticed: [],
    unanswered: [],
  };

  it("writes attempt-owned evidence + raw_claims with the ref mapping preserved", async () => {
    const deps = agentDeps(stubHubFetch(EXTRACTION));
    const registry3 = createHandlerRegistry(deps);
    const work = await seedExtractWork(deps);

    await registry3.extract(db, work);

    const claims = await sql`SELECT id, subject_key, attempt_id FROM raw_claims
                             WHERE attempt_id = ${work.attempt.id}`;
    expect(claims).toHaveLength(1);
    expect(claims[0]?.subject_key).toBe("model:qwen3.6-27b");
    const evidence = await sql`SELECT metadata, source_class FROM evidence
                               WHERE attempt_id = ${work.attempt.id}`;
    expect(evidence).toHaveLength(1);
    const meta = evidence[0]?.metadata as { rawClaimIds: string[] } | undefined;
    expect(meta?.rawClaimIds).toEqual([claims[0]?.id]);
    const attempt = await sql`SELECT output FROM attempts WHERE id = ${work.attempt.id}`;
    const out = attempt[0]?.output as { claims: unknown[] } | undefined;
    expect(out?.claims).toHaveLength(1);
  });

  it("an invented sourceUrl is a SCHEMA_FAILURE (re-extract, never re-research)", async () => {
    const bad = structuredClone(EXTRACTION);
    if (bad.evidence[0]) bad.evidence[0].sourceUrl = "https://invented.example.com";
    const deps = agentDeps(stubHubFetch(bad));
    const registry3 = createHandlerRegistry(deps);
    const work = await seedExtractWork(deps);
    await expect(registry3.extract(db, work)).rejects.toMatchObject({
      category: "SCHEMA_FAILURE",
    });
    const claims = await sql`SELECT id FROM raw_claims WHERE attempt_id = ${work.attempt.id}`;
    expect(claims).toHaveLength(0); // nothing persisted on failure
  });
});
