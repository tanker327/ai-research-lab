// Ticket 3.3 acceptance: the researcher loop is CODE-driven (ADR-016) — the
// model only ever picks one step; caps, tool errors, and note persistence are
// exercised with a stubbed ModelClient and stubbed tools. No DB, no network.
import type { ModelClient } from "@lab/model";
import type { ResearcherInput, ResearcherStep } from "@lab/schemas";
import { describe, expect, it } from "vitest";
import type { AgentContext } from "../../types";
import { researcherV1 } from "./index";

const INPUT: ResearcherInput = {
  question: "What quantizations does qwen3.6-27b support?",
  strategy: "primary_sources",
  successCriteria: ["cites official docs"],
  timeContext: "Current date: 2026-08-19.",
};

function stubModel(steps: ResearcherStep[]): { model: ModelClient; calls: number[] } {
  let i = 0;
  const calls: number[] = [];
  const model = {
    async generateStructured() {
      calls.push(i);
      const step = steps[Math.min(i, steps.length - 1)];
      i++;
      return {
        object: step,
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
  } as unknown as ModelClient;
  return { model, calls };
}

interface CtxOpts {
  maxToolCalls?: number;
  searchAvailable?: boolean;
  invokeImpl?: (name: string, input: unknown) => Promise<unknown>;
}

function makeCtx(model: ModelClient, opts: CtxOpts = {}) {
  const invoked: Array<{ name: string; input: unknown }> = [];
  const saved: Array<{ type: string; content: string | Uint8Array }> = [];
  const ctx: AgentContext = {
    runId: "r",
    taskId: "t",
    attemptId: "a",
    attemptNumber: 1,
    model,
    route: { tier: "strong_local", model: "default", mode: "json_schema" },
    tools: {
      allowed: ["web_fetch", "web_search"],
      async invoke(name, input) {
        invoked.push({ name, input });
        if (opts.invokeImpl) return opts.invokeImpl(name, input);
        return {
          url: (input as { url: string }).url,
          status: 200,
          contentType: "text/html",
          excerpt: "PostgreSQL supports FP8.",
          snapshotArtifactId: "00000000-0000-7000-8000-000000000001",
        };
      },
    },
    async saveArtifact(a) {
      saved.push({ type: a.type, content: a.content });
      return {
        id: "note-artifact-id",
        sha256: "x",
        storageUri: "file:///x",
        sizeBytes: 1,
        deduped: false,
      };
    },
    searchAvailable: opts.searchAvailable ?? false,
    limits: { maxToolCalls: opts.maxToolCalls ?? 3 },
    signal: new AbortController().signal,
  };
  return { ctx, invoked, saved };
}

const FINISH: ResearcherStep = {
  action: "finish",
  note: `# Question\n...\n# Findings\nlong enough note body to clear the fifty character schema minimum.`,
  selfAssessment: { complete: true, confidence: "high", gaps: [] },
};

describe("researcher v1 loop", () => {
  it("finish on first step: note saved as research_note artifact, id returned", async () => {
    const { model } = stubModel([FINISH]);
    const { ctx, saved } = makeCtx(model);
    const result = await researcherV1.run(INPUT, ctx);
    expect(result.noteArtifactId).toBe("note-artifact-id");
    expect(saved[0]?.type).toBe("research_note");
    expect(result.selfAssessment.confidence).toBe("high");
  });

  it("fetch then finish: tool invoked once, observation fed back", async () => {
    const { model, calls } = stubModel([
      { action: "fetch", url: "https://example.com/docs", why: "official docs" },
      FINISH,
    ]);
    const { ctx, invoked } = makeCtx(model);
    await researcherV1.run(INPUT, ctx);
    expect(invoked).toEqual([{ name: "web_fetch", input: { url: "https://example.com/docs" } }]);
    expect(calls.length).toBe(2);
  });

  it("a failing tool is an observation, not an attempt failure", async () => {
    const { model } = stubModel([
      { action: "fetch", url: "https://dead.example", why: "try" },
      FINISH,
    ]);
    const { ctx } = makeCtx(model, {
      invokeImpl: async () => {
        throw new Error("connection refused");
      },
    });
    const result = await researcherV1.run(INPUT, ctx);
    expect(result.noteArtifactId).toBe("note-artifact-id");
  });

  it("cap is enforced by code: a model that never finishes is QUALITY_FAILURE (ADR-016)", async () => {
    const { model, calls } = stubModel([
      { action: "fetch", url: "https://example.com/1", why: "more" },
    ]);
    const { ctx, invoked } = makeCtx(model, { maxToolCalls: 2 });
    await expect(researcherV1.run(INPUT, ctx)).rejects.toMatchObject({
      category: "QUALITY_FAILURE",
    });
    expect(invoked.length).toBe(2); // never more tool calls than the cap
    expect(calls.length).toBe(3); // cap + the forced-finish turn
  });
});
