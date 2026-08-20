// Ticket 5.1 contract test: schema in/out with a stubbed ModelClient. The
// synthesizer has NO tools (§18 — cannot import uncited facts); citation
// integrity is the deterministic validator's job (5.2), not tested here.
import type { ModelClient } from "@lab/model";
import type { SynthesizerInput, SynthesizerOutput } from "@lab/schemas";
import { describe, expect, it } from "vitest";
import type { AgentContext } from "../../types";
import { synthesizerV1 } from "./index";
import { buildMessages, SYSTEM } from "./prompt";

const INPUT: SynthesizerInput = {
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
  analysis: {
    findings: [
      { statement: "PG's DDL is transactional", canonicalClaimIds: ["claim-1"], implication: null },
    ],
    comparisons: [],
    unresolvedQuestions: [],
    confidenceNote: "single-source but authoritative",
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
  acceptedUncertainties: ["community reports not exhaustively sampled"],
  timeContext: "Current date: 2026-08-20.",
};

const OUTPUT: SynthesizerOutput = {
  title: "PostgreSQL transactional DDL",
  reportMarkdown:
    "PostgreSQL supports transactional DDL. [c1]\n\n## Uncertainties\n- community reports not exhaustively sampled",
  citationMap: { c1: ["claim-1"] },
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
    route: { tier: "frontier", model: "frontier-model", mode: "json_object" },
    tools: {
      allowed: [],
      async invoke() {
        throw new Error("synthesizer has no tools (§18)");
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

describe("synthesizerV1", () => {
  it("returns the parsed SynthesizerOutput", async () => {
    const out = await synthesizerV1.run(INPUT, makeCtx(OUTPUT));
    expect(out.citationMap.c1).toEqual(["claim-1"]);
    expect(out.reportMarkdown).toContain("[c1]");
  });

  it("throws on schema-invalid model output (chip with no claim ids)", async () => {
    const bad = { ...OUTPUT, citationMap: { c1: [] } };
    await expect(synthesizerV1.run(INPUT, makeCtx(bad))).rejects.toThrow();
  });

  it("prompt renders approved material, uncertainties, and the citation contract", () => {
    const msg = buildMessages(INPUT)[0]?.content as string;
    expect(msg).toContain("id=claim-1");
    expect(msg).toContain("community reports not exhaustively sampled");
    expect(msg).toContain("PG's DDL is transactional");
    expect(SYSTEM).toContain("citationMap");
    expect(SYSTEM).toContain("Uncertainties");
  });
});
