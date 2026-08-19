// Budget stub (ticket 1.7): reads caps from research_runs.budget but only
// produces warnings in Phase 1 — enforcement (WAITING_HUMAN checkpoint on
// breach, design §15.3) is Phase 4. Pure function so the wiring is testable
// before consumption data (model_calls/tool_calls) exists.
import { z } from "zod";

export const BudgetCaps = z
  .object({
    maxTasks: z.number().int().positive().optional(),
    maxCostUsd: z.number().positive().optional(),
    maxDurationMinutes: z.number().positive().optional(),
  })
  .loose();
export type BudgetCaps = z.infer<typeof BudgetCaps>;

export interface BudgetUsage {
  taskCount?: number;
}

export function checkBudgetStub(budget: Record<string, unknown>, usage: BudgetUsage): string[] {
  const parsed = BudgetCaps.safeParse(budget);
  if (!parsed.success) return [`budget JSON is malformed and will be ignored in Phase 1`];
  const caps = parsed.data;
  const warnings: string[] = [];
  if (caps.maxTasks !== undefined && (usage.taskCount ?? 0) > caps.maxTasks) {
    warnings.push(
      `task count ${usage.taskCount} exceeds budget.maxTasks ${caps.maxTasks} (warn-only in Phase 1)`,
    );
  }
  return warnings;
}
