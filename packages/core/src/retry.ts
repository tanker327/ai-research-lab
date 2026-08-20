// Retry ladder — implementation-plan §5.4. THE single place that decides what
// happens after a failed/rejected attempt (CLAUDE.md rule 10): deterministic
// checks and the Evaluator decide *whether* an output is rejected; decideRetry
// decides *what happens next*. Pure function — persistence of the
// DecisionRecord happens where transactions exist (Sessions C/D).
import type {
  CategorizedError,
  ModelTier,
  QualityVerdict,
  ResearchStrategy,
  TaskType,
} from "@lab/schemas";

export type RetryVerdict =
  | { kind: "infra_retry"; delayMs: number; rationale: string }
  | {
      kind: "intelligence_retry";
      strategy?: ResearchStrategy;
      tier?: ModelTier;
      rationale: string;
    }
  | { kind: "task_failed"; rationale: string };

// What decideRetry needs to know about the attempt — a projection of the
// attempts row, not a new contract (the row shape stays in @lab/db).
export interface RetryContext {
  taskType: TaskType;
  attemptNumber: number;
  infraRetryCount: number;
  strategy: ResearchStrategy | null;
}

const INFRA_BACKOFF = [5_000, 30_000, 120_000] as const;

const STRATEGY_FALLBACK: Partial<Record<ResearchStrategy, ResearchStrategy>> = {
  comparative: "primary_sources",
  broad_discovery: "community_evidence",
  benchmark_focused: "independent_validation",
};

export function decideRetry(
  a: RetryContext,
  err: CategorizedError | null,
  quality: QualityVerdict | null,
): RetryVerdict {
  // Infra failures back off without consuming intelligence attempts — the
  // model/strategy was never at fault.
  if (err?.category === "TRANSIENT_INFRA" || err?.category === "TOOL_FAILURE") {
    const delayMs = INFRA_BACKOFF[a.infraRetryCount];
    if (delayMs !== undefined) {
      return {
        kind: "infra_retry",
        delayMs,
        rationale: `${err.category} on infra retry ${a.infraRetryCount + 1}/${INFRA_BACKOFF.length}: backing off ${delayMs / 1000}s before re-running the same attempt configuration.`,
      };
    }
    return {
      kind: "task_failed",
      rationale: `${err.category} persisted through ${INFRA_BACKOFF.length} backoff retries — infrastructure is not recovering; failing the task.`,
    };
  }

  // Malformed structured output: attempt 1 retries the same configuration (a
  // constrained-decoding hiccup is cheap to re-run); attempt ≥2 ESCALATES to
  // the frontier tier — live finding: a deterministic local model at
  // temperature 0 replays the identical truncated output from cache in
  // milliseconds, so a same-configuration retry is a no-op. "Remodel" is a
  // designed failure response (P5). Extract still re-extracts from the
  // persisted note either way — never re-research (P8).
  if (err?.category === "SCHEMA_FAILURE") {
    const what =
      a.taskType === "extract"
        ? "re-extracting from the persisted research note (never re-research, P8)"
        : `re-running ${a.taskType}`;
    if (a.attemptNumber >= 2) {
      return {
        kind: "intelligence_retry",
        tier: "frontier",
        rationale: `SCHEMA_FAILURE on ${a.taskType} attempt ${a.attemptNumber}: the same configuration reproduced the malformed output — ${what} on the frontier tier.`,
      };
    }
    return {
      kind: "intelligence_retry",
      rationale: `SCHEMA_FAILURE on ${a.taskType}: ${what} at the same configuration — a decoding hiccup is cheap to retry; escalation follows if it repeats.`,
    };
  }

  // Quality ladder (design §632-3): attempt 2 = same tier, fallback strategy;
  // attempt 3 = frontier tier; then the Evaluator decides what failure means.
  if (quality?.rejected) {
    const reasons = quality.reasons.length > 0 ? ` Reasons: ${quality.reasons.join("; ")}` : "";
    if (a.attemptNumber === 1) {
      const strategy = a.strategy ? (STRATEGY_FALLBACK[a.strategy] ?? a.strategy) : undefined;
      return {
        kind: "intelligence_retry",
        strategy,
        rationale: `Quality-rejected on attempt 1: retrying at the same tier with strategy ${strategy ?? "unchanged"}.${reasons}`,
      };
    }
    if (a.attemptNumber === 2) {
      return {
        kind: "intelligence_retry",
        tier: "frontier",
        rationale: `Quality-rejected on attempt 2: escalating to frontier tier with the best prior strategy.${reasons}`,
      };
    }
    return {
      kind: "task_failed",
      rationale: `Quality-rejected on attempt ${a.attemptNumber}: intelligence ladder exhausted (strategy fallback and tier escalation both rejected); failing the task.${reasons}`,
    };
  }

  return {
    kind: "task_failed",
    rationale: err
      ? `${err.category} is not retryable by policy: ${err.message}`
      : "Attempt failed with no categorized error and no quality verdict — nothing to retry against; failing the task.",
  };
}

// The attempt budget is a hard cap ON TOP of the ladder (design §8.1) — part
// of retry policy, so it lives here (rule 10) and every caller of decideRetry
// applies it the same way.
export function enforceAttemptCap(
  verdict: RetryVerdict,
  attemptCount: number,
  maxAttempts: number,
): RetryVerdict {
  if (verdict.kind !== "task_failed" && attemptCount >= maxAttempts) {
    return {
      kind: "task_failed",
      rationale: `max_attempts (${maxAttempts}) exhausted after ${attemptCount} attempts; overriding ${verdict.kind}. Ladder said: ${verdict.rationale}`,
    };
  }
  return verdict;
}
