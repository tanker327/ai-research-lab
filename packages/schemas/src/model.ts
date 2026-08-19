// ModelClient contracts (rule 2). The client itself lives in packages/model;
// api/worker/web type against these.
import { z } from "zod";
import { ModelTier } from "./enums";

export const ModelCallPurpose = z.enum(["agent", "canonical_merge", "validator"]);
export type ModelCallPurpose = z.infer<typeof ModelCallPurpose>;

// Every model call is owned by an attempt (rule 5) and priced/attributed.
export const ModelCallContext = z.object({
  runId: z.string().uuid(),
  taskId: z.string().uuid().nullish(),
  attemptId: z.string().uuid(),
  tier: ModelTier,
  purpose: ModelCallPurpose.default("agent"),
  createdBy: z.string().min(1), // agent name or 'system'
});
export type ModelCallContext = z.infer<typeof ModelCallContext>;

export const ModelMessage = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});
export type ModelMessage = z.infer<typeof ModelMessage>;

// D2 (phase-2-plan): structured output is a per-provider capability —
// json_schema where the backend constrains decoding, json_object+parse where
// it can't (deepseek). Callers never branch on this; the router supplies it.
export const StructuredMode = z.enum(["json_schema", "json_object"]);
export type StructuredMode = z.infer<typeof StructuredMode>;
