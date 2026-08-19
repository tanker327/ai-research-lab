// Phase-1 fake task input (phase-1-plan Session B). The worker's fake handler
// registry executes these instead of agents until Phase 2 wires the real
// dispatch. Lives here because task input is a cross-package contract (rule 2)
// — the API/gate seeds it, the worker parses it. ADR-011 still applies: the
// input is fully concrete at task creation.
import { z } from "zod";
import { ErrorCategory } from "./errors";

export const FakeTaskInput = z.object({
  fake: z
    .discriminatedUnion("behavior", [
      z.object({ behavior: z.literal("sleep"), ms: z.number().int().nonnegative().default(10) }),
      z.object({
        behavior: z.literal("fail"),
        category: ErrorCategory.default("TRANSIENT_INFRA"),
        message: z.string().default("injected failure"),
      }),
      z.object({
        behavior: z.literal("side_effect"),
        excerpt: z.string().default("fake evidence"),
        // sleep AFTER writing — the gate SIGKILLs a worker inside this window
        // to prove a dead attempt's rows never go live.
        sleepMs: z.number().int().nonnegative().default(0),
      }),
    ])
    .default({ behavior: "sleep", ms: 10 }),
});
export type FakeTaskInput = z.infer<typeof FakeTaskInput>;
