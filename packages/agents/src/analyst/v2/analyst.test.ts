// Ticket 8.4 contract test: v2 = v1's thin structured call + schemaFeedback
// rendering and id discipline in the prompt. Stubbed ModelClient — citation
// integrity stays in core checks.
import type { ModelClient } from "@lab/model";
import type { AnalysisOutput, AnalystInput } from "@lab/schemas";
import { describe, expect, it } from "vitest";
import type { AgentContext } from "../../types";
import { analystV2 } from "./index";
import { buildMessages, SYSTEM } from "./prompt";

const INPUT: AnalystInput = {
  specification: {
    version: 1,
    objective: "does PG support transactional DDL?",
    scope: [],
    exclusions: [],
    constraints: [],
    successCriteria: ["cite official docs"],
    keyQuestions: ["what are the limits?"],
    clarificationsAssumed: [],
  },
  claimBundle: [
    {
      id: "claim-1",
      subjectKey: "db:postgresql",
      predicateKey: "transactional_ddl",
      statement: "PostgreSQL supports transactional DDL",
      status: "supported",
      contestNote: null,
      evidence: [
        {
          relation: "supports",
          sourceClass: "official_docs",
          sourceUrl: "https://postgresql.org/docs",
          vendorAffiliated: null,
          benchmarkOrigin: null,
          excerpt: "DDL is transactional…",
        },
      ],
    },
  ],
  openContests: [],
  schemaFeedback: [],
  timeContext: "Current date: 2026-08-20.",
};

const OUTPUT: AnalysisOutput = {
  findings: [
    { statement: "PG's DDL is transactional", canonicalClaimIds: ["claim-1"], implication: null },
  ],
  comparisons: [],
  unresolvedQuestions: [],
  confidenceNote: "single-source but authoritative",
};

function makeCtx(object: unknown) {
  const ctx: AgentContext = {
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
          finishReason: "stop",
        };
      },
      async generateText() {
        throw new Error("unused");
      },
    } as unknown as ModelClient,
    route: { tier: "strong_local", model: "default", mode: "json_schema" },
    tools: {
      allowed: [],
      async invoke() {
        throw new Error("analyst has no tools");
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
  return ctx;
}

describe("analystV2", () => {
  it("returns the parsed AnalysisOutput and reports version v2", async () => {
    expect(analystV2.version).toBe("v2");
    const out = await analystV2.run(INPUT, makeCtx(OUTPUT));
    expect(out.findings[0]?.canonicalClaimIds).toEqual(["claim-1"]);
  });

  it("throws on schema-invalid model output", async () => {
    const bad = {
      ...OUTPUT,
      findings: [{ statement: "uncited", canonicalClaimIds: [], implication: null }],
    };
    await expect(analystV2.run(INPUT, makeCtx(bad))).rejects.toThrow();
  });

  it("renders schemaFeedback as the failure-fix section when present, omits it when empty", () => {
    const noFeedback = buildMessages(INPUT)[0]?.content as string;
    expect(noFeedback).not.toContain("Previous attempt failed");

    const withFeedback = buildMessages({
      ...INPUT,
      schemaFeedback: ["Fix exactly this: canonicalClaimIds entries must be single ids"],
    })[0]?.content as string;
    expect(withFeedback).toContain("## Previous attempt failed — fix this");
    expect(withFeedback).toContain("single ids");
  });

  it("prompt keeps v1's contract language and adds id discipline", () => {
    expect(SYSTEM).toContain("EXACTLY ONE id");
    expect(SYSTEM).toContain("never join two ids");
    expect(SYSTEM).toContain("canonicalClaimIds");
    expect(SYSTEM).toContain("token budget");
  });
});
