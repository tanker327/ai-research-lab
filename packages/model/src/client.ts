// ModelClient (§5.6, phase-2-plan Session A): AI SDK → ai-hub. Every call
// writes a model_calls row owned by the caller's attempt (rule 5); reasoning
// content goes to the injected sink as a type='reasoning' artifact and is
// NEVER returned into agent context (ADR-018, rule 9 — this client returns
// only the object/text). Hub auth is the x-service-name header (pre-flight).
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { type Db, insertModelCall } from "@lab/db";
import {
  CategorizedError,
  type ModelCallContext,
  type ModelMessage,
  newId,
  type StructuredMode,
} from "@lab/schemas";
import { generateText, Output } from "ai";
import { z } from "zod";
import { mapModelError } from "./errors";
import { createTierLimiter, type TierLimiter } from "./semaphore";

export interface ModelClientOptions {
  baseUrl: string;
  serviceName: string;
  db: Db;
  // 2.4 wires the content-addressed artifact store here; returns artifact id.
  reasoningSink?: (ctx: ModelCallContext, reasoning: string) => Promise<string | null>;
  fetch?: typeof globalThis.fetch; // tests inject a stub
  // D3: client-side per-tier in-flight caps (e.g. { strong_local: GPU_CONCURRENCY_STRONG_LOCAL }).
  concurrency?: Partial<Record<ModelCallContext["tier"], number>>;
}

export interface GenerateBaseArgs {
  ctx: ModelCallContext;
  model: string; // hub alias ('default', 'cheapest', …) or full provider id
  system?: string;
  messages: ModelMessage[];
  temperature?: number;
  maxOutputTokens?: number;
}

export interface GenerateStructuredArgs<T> extends GenerateBaseArgs {
  schema: z.ZodType<T>;
  schemaName?: string;
  // D2: capability of the resolved provider — the router (2.2) supplies it.
  mode?: StructuredMode;
}

export interface ModelCallMeta {
  callId: string;
  model: string; // resolved model id from the response
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  latencyMs: number;
  finishReason: string | null; // 'length' = truncation — retry feedback differs (D6)
}

export interface ModelClient {
  generateStructured<T>(args: GenerateStructuredArgs<T>): Promise<{ object: T } & ModelCallMeta>;
  generateText(args: GenerateBaseArgs): Promise<{ text: string } & ModelCallMeta>;
}

export function createModelClient(opts: ModelClientOptions): ModelClient {
  // Two provider instances because supportsStructuredOutputs is provider-wide
  // at runtime (languageModel's per-model config arg is typed but ignored by
  // @ai-sdk/openai-compatible@3 — verified against dist).
  const providerSettings = {
    name: "aihub",
    baseURL: opts.baseUrl,
    headers: { "x-service-name": opts.serviceName },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  };
  const structuredProvider = createOpenAICompatible({
    ...providerSettings,
    supportsStructuredOutputs: true,
  });
  const plainProvider = createOpenAICompatible(providerSettings);
  const limiter: TierLimiter = createTierLimiter(opts.concurrency ?? {});

  async function run<T>(
    args: GenerateBaseArgs,
    output: { schema: z.ZodType<T>; name?: string; mode: StructuredMode; parse?: "self" } | null,
  ): Promise<{ object?: T; text: string } & ModelCallMeta> {
    const t0 = Date.now();
    // json_schema → the backend constrains decoding (ADR-012); json_object →
    // the SDK validates the parsed JSON against the Zod schema client-side.
    const model =
      output?.mode === "json_schema"
        ? structuredProvider.languageModel(args.model)
        : plainProvider.languageModel(args.model);

    // json_object mode sends no schema on the wire, so the model must see it
    // in the prompt — without this, providers invent their own shape (found
    // live against deepseek). Zod still validates the parsed result.
    let system = args.system;
    if (output && output.mode === "json_object") {
      const schemaJson = JSON.stringify(z.toJSONSchema(output.schema));
      system = `${system ? `${system}\n\n` : ""}Respond with a single JSON object that matches this JSON Schema exactly — no prose, no markdown fences:\n${schemaJson}`;
    }

    try {
      const res = await limiter.withPermit(args.ctx.tier, () =>
        generateText({
          model,
          // Rule 10: decideRetry owns ALL retry policy — the SDK's built-in
          // transport retries would mask transient failures from the ladder.
          maxRetries: 0,
          system,
          messages: args.messages,
          temperature: args.temperature,
          maxOutputTokens: args.maxOutputTokens,
          ...(output && output.parse !== "self"
            ? { output: Output.object({ schema: output.schema, name: output.name }) }
            : {}),
        }),
      );

      const meta = await persistCall({
        args,
        resolvedModel: res.response.modelId || args.model,
        inputTokens: res.usage.inputTokens ?? null,
        outputTokens: res.usage.outputTokens ?? null,
        costUsd: costFromHeaders(res.response.headers),
        latencyMs: Date.now() - t0,
        finishReason: res.finishReason,
        reasoning: res.reasoningText ?? null,
      });
      return {
        object: output && output.parse !== "self" ? (res.output as T) : undefined,
        text: res.text,
        ...meta,
      };
    } catch (err) {
      throw mapModelError(err, args.model);
    }
  }

  // json_object mode: the SDK DROPS response_format for providers without
  // structuredOutputs (its warning "responseFormat is not supported"), so the
  // model may fence or preface the JSON. We parse robustly ourselves: strip
  // fences, take the outermost object, Zod-validate (rule 7 — a real mismatch
  // is still SCHEMA_FAILURE).
  function extractJsonObject(text: string): unknown {
    const stripped = text
      .replace(/^[\s\S]*?```(?:json)?\s*\n?/, (m) => (m.includes("```") ? "" : m))
      .replace(/```[\s\S]*$/, "");
    const candidate = stripped.includes("{") ? stripped : text;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) {
      throw new Error(
        text.trim().length === 0
          ? "model produced no content — reasoning likely exhausted the output budget (finishReason=length)"
          : "no JSON object in model output",
      );
    }
    return JSON.parse(candidate.slice(start, end + 1));
  }

  async function persistCall(p: {
    args: GenerateBaseArgs;
    resolvedModel: string;
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
    latencyMs: number;
    finishReason: string | null;
    reasoning: string | null;
  }): Promise<ModelCallMeta> {
    const { ctx } = p.args;
    let reasoningArtifactId: string | null = null;
    if (p.reasoning && opts.reasoningSink) {
      reasoningArtifactId = await opts.reasoningSink(ctx, p.reasoning);
    }
    const callId = newId();
    await insertModelCall(opts.db, {
      id: callId,
      runId: ctx.runId,
      attemptId: ctx.attemptId,
      model: p.resolvedModel,
      modelTier: ctx.tier,
      purpose: ctx.purpose,
      inputTokens: p.inputTokens,
      outputTokens: p.outputTokens,
      costUsd: p.costUsd,
      latencyMs: p.latencyMs,
      finishReason: p.finishReason,
      reasoningArtifactId,
    });
    return {
      callId,
      model: p.resolvedModel,
      inputTokens: p.inputTokens,
      outputTokens: p.outputTokens,
      costUsd: p.costUsd,
      latencyMs: p.latencyMs,
      finishReason: p.finishReason,
    };
  }

  return {
    async generateStructured(args) {
      const { schema, schemaName, mode = "json_schema", ...base } = args;
      if (mode === "json_object") {
        // Schema goes into the prompt; parsing is ours (see extractJsonObject).
        const res = await run(base, { schema, name: schemaName, mode, parse: "self" });
        try {
          const object = schema.parse(extractJsonObject(res.text));
          const { text: _text, object: _o, ...meta } = res;
          return { object, ...meta };
        } catch (err) {
          throw new CategorizedError(
            "SCHEMA_FAILURE",
            `model output failed schema validation (${args.model})`,
            // detail is what attempts.error persists — keep the cause legible.
            {
              cause: err,
              detail: {
                truncated: res.finishReason === "length",
                cause: String(err instanceof Error ? err.message : err).slice(0, 500),
              },
            },
          );
        }
      }
      const res = await run(base, { schema, name: schemaName, mode });
      if (res.object === undefined) {
        // Output.object guarantees an object on success; belt for the types.
        throw mapModelError(new Error("no structured output produced"), args.model);
      }
      const { object, text: _text, ...meta } = res;
      return { object, ...meta };
    },
    async generateText(args) {
      const { object: _object, ...res } = await run(args, null);
      return res;
    },
  };
}

function costFromHeaders(headers: Record<string, string> | undefined): number | null {
  const raw = headers?.["x-hub-cost-usd"];
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
