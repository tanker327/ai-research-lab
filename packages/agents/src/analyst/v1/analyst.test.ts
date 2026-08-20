// Ticket 4.2 contract test: schema in/out with a stubbed ModelClient — the
// agent is a thin structured call; citation integrity lives in core checks.
import type { ModelClient } from "@lab/model";
import type { AnalysisOutput, AnalystInput } from "@lab/schemas";
import { describe, expect, it } from "vitest";
import type { AgentContext } from "../../types";
import { analystV1 } from "./index";
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
  timeContext: "Current date: 2026-08-19.",
};

const OUTPUT: AnalysisOutput = {
  findings: [
    { statement: "PG's DDL is transactional", canonicalClaimIds: ["claim-1"], implication: null },
  ],
  comparisons: [],
  unresolvedQuestions: ["concurrent index builds?"],
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

describe("analystV1", () => {
  it("returns the parsed AnalysisOutput", async () => {
    const out = await analystV1.run(INPUT, makeCtx(OUTPUT));
    expect(out.findings[0]?.canonicalClaimIds).toEqual(["claim-1"]);
  });

  it("throws on schema-invalid model output (finding without citations)", async () => {
    const bad = {
      ...OUTPUT,
      findings: [{ statement: "uncited", canonicalClaimIds: [], implication: null }],
    };
    await expect(analystV1.run(INPUT, makeCtx(bad))).rejects.toThrow();
  });

  it("prompt renders claim ids, source facts, and contest markers", () => {
    const msg = buildMessages({
      ...INPUT,
      openContests: [{ claimId: "claim-1", statement: "s", contestNote: "docs disagree" }],
    })[0]?.content as string;
    expect(msg).toContain("id=claim-1");
    expect(msg).toContain("affiliation-unknown");
    expect(msg).toContain("docs disagree");
    expect(SYSTEM).toContain("canonicalClaimIds");
  });
});
