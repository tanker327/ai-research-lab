// Model-call error taxonomy mapping (design §14). Transport/status errors are
// duck-typed (the AI SDK's APICallError carries statusCode) so the mapping
// survives SDK class identity changes.
import { CategorizedError } from "@lab/schemas";

function statusCodeOf(err: unknown): number | null {
  if (typeof err === "object" && err !== null && "statusCode" in err) {
    const sc = (err as { statusCode: unknown }).statusCode;
    if (typeof sc === "number") return sc;
  }
  return null;
}

function nameOf(err: unknown): string {
  return err instanceof Error ? err.name : "";
}

export function mapModelError(err: unknown, model: string): CategorizedError {
  if (err instanceof CategorizedError) return err;

  // Structured output did not match the schema — the ladder's re-extract /
  // reject path, never a transport retry (rule 7).
  if (/NoObjectGeneratedError|NoOutputGeneratedError|TypeValidationError/.test(nameOf(err))) {
    // NoObjectGeneratedError carries the finishReason — a 'length' finish is
    // truncation, not malformation, and the retry feedback differs (D6).
    const finishReason =
      typeof err === "object" && err !== null && "finishReason" in err
        ? (err as { finishReason: unknown }).finishReason
        : null;
    return new CategorizedError(
      "SCHEMA_FAILURE",
      `model output failed schema validation (${model})`,
      {
        cause: err,
        detail: {
          truncated: finishReason === "length",
          // The Zod issue list lives on the wrapped cause, not the wrapper.
          cause: String(
            err instanceof Error && err.cause instanceof Error ? err.cause.message : err,
          ).slice(0, 500),
        },
      },
    );
  }

  const status = statusCodeOf(err);
  if (status !== null) {
    if (status === 408 || status === 429 || status >= 500) {
      return new CategorizedError("TRANSIENT_INFRA", `ai-hub upstream ${status} (${model})`, {
        cause: err,
      });
    }
    if (status === 401 || status === 403 || status === 404) {
      return new CategorizedError(
        "PERMANENT_INFRA",
        `ai-hub rejected the call: HTTP ${status} (${model}) — check keys/model id on the hub`,
        { cause: err },
      );
    }
    return new CategorizedError("MODEL_FAILURE", `ai-hub upstream ${status} (${model})`, {
      cause: err,
    });
  }

  // fetch-level failures (ECONNREFUSED, DNS, abort) — infrastructure.
  return new CategorizedError("TRANSIENT_INFRA", `model call transport failure (${model})`, {
    cause: err,
  });
}
