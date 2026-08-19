// Error taxonomy (design §14). No bare `throw new Error` anywhere in the
// codebase — every thrown error is a CategorizedError so the Retry Coordinator
// can map category → recovery path (infra backoff vs intelligence ladder).
import { z } from "zod";

export const ErrorCategory = z.enum([
  "TRANSIENT_INFRA",
  "PERMANENT_INFRA",
  "MODEL_FAILURE",
  "TOOL_FAILURE",
  "SCHEMA_FAILURE",
  "QUALITY_FAILURE",
  "BUDGET_EXCEEDED",
  "CANCELLED",
  "HUMAN_REQUIRED",
  "UNKNOWN",
]);
export type ErrorCategory = z.infer<typeof ErrorCategory>;

// Shape persisted into attempts.error (database-schema.md §4).
export const AttemptError = z.object({
  category: ErrorCategory,
  message: z.string(),
  detail: z.unknown().optional(),
});
export type AttemptError = z.infer<typeof AttemptError>;

export class CategorizedError extends Error {
  readonly category: ErrorCategory;
  readonly detail: unknown;

  constructor(
    category: ErrorCategory,
    message: string,
    options?: { detail?: unknown; cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = "CategorizedError";
    this.category = category;
    this.detail = options?.detail;
  }

  toAttemptError(): AttemptError {
    return { category: this.category, message: this.message, detail: this.detail };
  }

  static from(err: unknown, fallback: ErrorCategory = "UNKNOWN"): CategorizedError {
    if (err instanceof CategorizedError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new CategorizedError(fallback, message, { cause: err });
  }
}
