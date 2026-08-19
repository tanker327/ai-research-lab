import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

const valid = {
  DATABASE_URL: "postgres://lab:lab@localhost:5434/research_lab",
  AIHUB_BASE_URL: "http://ai-hub.local:3000/v1",
  MODEL_FRONTIER: "claude-opus-4-8",
  MODEL_STRONG_LOCAL: "qwen3.6-27b-fp8",
  MODEL_FAST_LOCAL: "qwen3.5-7b",
};

describe("loadConfig", () => {
  it("parses a valid env and applies defaults", () => {
    const c = loadConfig(valid);
    expect(c.WORKER_CONCURRENCY).toBe(2);
    expect(c.POLL_INTERVAL_MS).toBe(500);
    expect(c.API_PORT).toBe(8787);
    expect(c.STALE_SWEEP_INTERVAL_MS).toBe(30_000);
    expect(c.ARTIFACT_ROOT).toBe("./data/artifacts");
  });

  it("coerces numeric env strings", () => {
    expect(loadConfig({ ...valid, WORKER_CONCURRENCY: "4" }).WORKER_CONCURRENCY).toBe(4);
  });

  it("crashes at boot on a missing required var, naming it", () => {
    const { DATABASE_URL: _omitted, ...rest } = valid;
    expect(() => loadConfig(rest)).toThrow(/DATABASE_URL/);
  });

  it("rejects malformed values", () => {
    expect(() => loadConfig({ ...valid, AIHUB_BASE_URL: "not a url" })).toThrow();
    expect(() => loadConfig({ ...valid, POLL_INTERVAL_MS: "-5" })).toThrow();
  });
});
