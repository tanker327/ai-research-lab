// Ticket 4.3 contract test: schema in/out with a stubbed ModelClient. The
// consistency rules (anti-rubber-stamp etc.) are core checks, not agent code.
import type { ModelClient } from "@lab/model";
import type { EvaluatorInput, EvaluatorOutput } from "@lab/schemas";
import { describe, expect, it } from "vitest";
import type { AgentContext } from "../../types";
import { evaluatorV1 } from "./index";
import { buildMessages, SYSTEM } from "./prompt";

const INPUT: EvaluatorInput = {
  specification: {
    version: 1,
    objective: "does PG support transactional DDL?",
    scope: [],
    exclusions: [],
    constraints: [],
    successCriteria: ["cite official docs"],
    keyQuestions: [],
    clarificationsAssumed: [],
  },
  analysis: {
    findings: [{ statement: "yes", canonicalClaimIds: ["c1"], implication: null }],
    comparisons: [],
    unresolvedQuestions: [],
    confidenceNote: "ok",
  },
  claimBundle: [
    {
      id: "c1",
      subjectKey: "db:postgresql",
      predicateKey: "transactional_ddl",
      statement: "supported",
      status: "contested",
      contestNote: "one blog disagrees",
      evidence: [],
    },
  ],
  coverage: {
    evidenceCount: 1,
    claimCount: 1,
    contestedCount: 1,
    distinctPublishers: 1,
    distinctOrigins: 0,
    vendorRatio: 1,
    sourceClassMix: [],
    perQuestion: [],
    oldestEvidence: null,
    newestEvidence: null,
  },
  runMetrics: { attemptsUsed: 4, tasksDone: 3, tasksFailed: 0, cyclesCompleted: 0, costUsd: 0.01 },
  maxCycles: 3,
  timeContext: "Current date: 2026-08-19.",
};

const OUTPUT: EvaluatorOutput = {
  issues: [
    {
      severity: "high",
      category: "source_quality",
      description: "vendor-only backing",
      suggestedResearchQuestion: null,
    },
  ],
  decision: "RESEARCH_MORE",
  reasons: ["needs an independent source"],
  requiredActions: [
    {
      kind: "research",
      question: "Find an independent benchmark of PG DDL rollback",
      seedUrls: null,
      rationale: "vendor-only",
    },
  ],
  acceptedUncertainties: [],
  criterionVerdicts: [],
};

function makeCtx(object: unknown): AgentContext {
  return {
    runId: "r",
    taskId: "t",
    attemptId: "a",
    attemptNumber: 1,
    model: {
      async generateStructured() {
        return {
          object,
          callId: "c",
          model: "m",
          inputTokens: 1,
          outputTokens: 1,
          costUsd: null,
          latencyMs: 1,
        };
      },
      async generateText() {
        throw new Error("unused");
      },
    } as unknown as ModelClient,
    route: { tier: "frontier", model: "deepseek/deepseek-v4-pro", mode: "json_object" },
    tools: {
      allowed: [],
      async invoke() {
        throw new Error("evaluator has no tools (design §16)");
      },
    },
    saveArtifact: async () => {
      throw new Error("unused");
    },
    readArtifact: async () => {
      throw new Error("unused");
    },
    searchAvailable: false,
    limits: { maxToolCalls: 0 },
    signal: new AbortController().signal,
  };
}

describe("evaluatorV1", () => {
  it("returns the parsed EvaluatorOutput", async () => {
    const out = await evaluatorV1.run(INPUT, makeCtx(OUTPUT));
    expect(out.decision).toBe("RESEARCH_MORE");
    expect(out.requiredActions[0]?.question).toContain("independent benchmark");
  });

  it("throws on schema-invalid output (empty reasons / short question)", async () => {
    await expect(evaluatorV1.run(INPUT, makeCtx({ ...OUTPUT, reasons: [] }))).rejects.toThrow();
    const shortQ = {
      ...OUTPUT,
      requiredActions: [{ ...OUTPUT.requiredActions[0], question: "why?" }],
    };
    await expect(evaluatorV1.run(INPUT, makeCtx(shortQ))).rejects.toThrow();
  });

  it("prompt carries coverage facts, contest markers, and cycle budget", () => {
    const msg = buildMessages(INPUT)[0]?.content as string;
    expect(msg).toContain('"vendorRatio":1');
    expect(msg).toContain("contested: one blog disagrees");
    expect(msg).toContain("maxCycles: 3");
    expect(SYSTEM).toContain("requiredActions");
    expect(SYSTEM).toContain("no web access");
  });
});
