// Token budgeting (design §12). V0.05 estimator is chars/4 — a real tokenizer
// is a deferred trigger (implementation-plan §10). Overflow degrades digests
// in the §12 order; hard content (spec, success criteria, contested claims,
// the request itself) is NEVER dropped — if it alone exceeds the budget, the
// build fails loudly: that is a task-sizing bug, not something to hide.
import { CategorizedError } from "@lab/schemas";

export interface RoleBudgets {
  planner: number;
  researcher: number;
  extractor: number;
}

// Comfortably inside strong_local's context while leaving room for the
// prompt scaffold and the output budget.
export const DEFAULT_BUDGETS: RoleBudgets = {
  planner: 12_000,
  researcher: 6_000,
  extractor: 12_000,
};

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface FitResult<T> {
  value: T;
  degraded: boolean; // true if any fallback step was taken (event-worthy)
}

// Try renderings from richest to leanest; return the first that fits together
// with the hard content. If even the leanest doesn't fit — or the hard content
// alone is over budget — fail loudly.
export function fitToBudget<T>(args: {
  role: string;
  budgetTokens: number;
  hardTokens: number;
  renderings: Array<{ label: string; value: T; tokens: number }>;
}): FitResult<T> {
  const { role, budgetTokens, hardTokens, renderings } = args;
  if (hardTokens > budgetTokens) {
    throw new CategorizedError(
      "QUALITY_FAILURE",
      `context build for ${role}: hard content (${hardTokens} tok) exceeds budget (${budgetTokens} tok) — task is mis-sized, refusing to silently drop constraints`,
      { detail: { role, budgetTokens, hardTokens } },
    );
  }
  for (let i = 0; i < renderings.length; i++) {
    const r = renderings[i];
    if (r && hardTokens + r.tokens <= budgetTokens) {
      return { value: r.value, degraded: i > 0 };
    }
  }
  const leanest = renderings.at(-1);
  throw new CategorizedError(
    "QUALITY_FAILURE",
    `context build for ${role}: even leanest rendering (${leanest?.tokens ?? 0} tok) + hard content (${hardTokens} tok) exceeds budget (${budgetTokens} tok)`,
    { detail: { role, budgetTokens, hardTokens, leanestTokens: leanest?.tokens ?? 0 } },
  );
}
