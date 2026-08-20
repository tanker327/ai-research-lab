// API DTOs (rule 2): api validates requests with these; the worker/gate/web
// import the same shapes. Phase 1 runs take an explicit task list — the
// Planner replaces this entry point in Phase 3.
import { z } from "zod";
import { TaskType } from "./enums";
import { RoleTiers } from "./routing";

export const CreateRunTask = z.object({
  id: z.string().uuid().optional(),
  type: TaskType,
  title: z.string().min(1),
  priority: z.number().int().min(0).max(100).default(50),
  strategy: z.string().nullish(),
  maxAttempts: z.number().int().positive().default(3),
  // ADR-011: fully concrete at creation — no templates.
  input: z.record(z.string(), z.unknown()).default({}),
  dependsOn: z.array(z.string().uuid()).default([]),
});
export type CreateRunTask = z.infer<typeof CreateRunTask>;

export const CreateRunRequest = z.object({
  title: z.string().nullish(),
  userRequest: z.string().min(1),
  budget: z.record(z.string(), z.unknown()).default({}),
  // Absent tasks = planner-driven run (3.7): the api seeds a single stage-1
  // plan task and staged planning grows the DAG (ADR-011). An explicit list
  // remains for demos/tests/gates.
  tasks: z.array(CreateRunTask).min(1).optional(),
  // 7.1 (phase-7-plan D4): per-role TIER preference for this run. Persisted
  // on research_runs.metadata.roleTiers; the worker resolves task override >
  // this map > the policy table.
  roleTiers: RoleTiers.optional(),
  // 7.2 (phase-7-plan D1): pause after STAGE-1 plan acceptance for human
  // review (plan_review checkpoint, run WAITING_HUMAN) — the user edits the
  // plan and approves before research starts. Default off so gates/scripts
  // are unaffected; the console turns it on.
  reviewPlan: z.boolean().default(false),
});
export type CreateRunRequest = z.infer<typeof CreateRunRequest>;

// Checkpoint resolution (ticket 6.4, phase-6-plan D5): three deliberately
// small verbs; the Control Plane interprets (ADR-003 applies to humans too).
export const ResolveCheckpointRequest = z.object({
  // approve joined in 7.2: releases a plan_review hold (phase-7-plan D5).
  action: z.enum(["retry", "accept", "stop", "approve"]),
  note: z.string().max(2000).optional(),
  actor: z.string().max(200).optional(),
});
export type ResolveCheckpointRequest = z.infer<typeof ResolveCheckpointRequest>;
