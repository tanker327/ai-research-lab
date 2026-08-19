// API DTOs (rule 2): api validates requests with these; the worker/gate/web
// import the same shapes. Phase 1 runs take an explicit task list — the
// Planner replaces this entry point in Phase 3.
import { z } from "zod";
import { TaskType } from "./enums";

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
  tasks: z.array(CreateRunTask).min(1),
});
export type CreateRunRequest = z.infer<typeof CreateRunRequest>;
