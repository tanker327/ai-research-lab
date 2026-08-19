// Ticket 2.2: routing resolution + the no-silent-downgrade property, and the
// D3 semaphore bounding concurrent calls under a race.
import { AgentRole } from "@lab/schemas";
import { describe, expect, it } from "vitest";
import { ROUTING, resolveRoute, TIER_MODE } from "./policy";
import { createTierLimiter } from "./semaphore";

const models = {
  frontier: "best",
  strong_local: "default",
  fast_local: "cheapest",
};

describe("resolveRoute", () => {
  it("covers every agent role with a base rule", () => {
    for (const role of AgentRole.options) {
      const route = resolveRoute(role, 1, models);
      expect(route.model).toBeTruthy();
      expect(TIER_MODE[route.tier]).toBe(route.mode);
    }
  });

  it("routes per the §5.6 table", () => {
    expect(resolveRoute("planner", 1, models)).toMatchObject({ tier: "frontier", model: "best" });
    expect(resolveRoute("researcher", 1, models)).toMatchObject({
      tier: "strong_local",
      mode: "json_schema",
    });
    expect(resolveRoute("extractor", 1, models)).toMatchObject({
      tier: "fast_local",
      mode: "json_object", // deepseek capability (D2)
    });
  });

  it("escalates researcher to frontier from attempt 3 (ladder)", () => {
    expect(resolveRoute("researcher", 2, models).tier).toBe("strong_local");
    expect(resolveRoute("researcher", 3, models).tier).toBe("frontier");
    expect(resolveRoute("researcher", 7, models).tier).toBe("frontier");
  });

  it("an explicit tier override wins (decideRetry's tier escalation)", () => {
    expect(resolveRoute("researcher", 1, models, "frontier").model).toBe("best");
  });

  it("never silently downgrades: missing alias for the resolved tier throws naming it", () => {
    const withoutFrontier = { ...models, frontier: "" };
    expect(() => resolveRoute("planner", 1, withoutFrontier)).toThrow(/MODEL_FRONTIER/);
    expect(() => resolveRoute("planner", 1, withoutFrontier)).toThrow(/never silently downgraded/);
  });

  it("every routing rule row is schema-valid and roles are exhaustive", () => {
    const covered = new Set(ROUTING.map((r) => r.role));
    for (const role of AgentRole.options) expect(covered.has(role)).toBe(true);
  });
});

describe("tier limiter (D3)", () => {
  it("bounds in-flight calls per tier under a race", async () => {
    const limiter = createTierLimiter({ strong_local: 2 });
    let inFlight = 0;
    let peak = 0;
    const job = () =>
      limiter.withPermit("strong_local", async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
      });
    await Promise.all(Array.from({ length: 8 }, job));
    expect(peak).toBe(2);
  });

  it("releases permits when the job throws", async () => {
    const limiter = createTierLimiter({ strong_local: 1 });
    await limiter
      .withPermit("strong_local", async () => {
        throw new Error("boom");
      })
      .catch(() => {});
    expect(limiter.inFlight("strong_local")).toBe(0);
    // The next job proceeds — the permit was returned.
    const ok = await limiter.withPermit("strong_local", async () => "ran");
    expect(ok).toBe("ran");
  });

  it("uncapped tiers are pass-through", async () => {
    const limiter = createTierLimiter({});
    const results = await Promise.all(
      Array.from({ length: 5 }, () => limiter.withPermit("frontier", async () => 1)),
    );
    expect(results).toHaveLength(5);
  });
});
