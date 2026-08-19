# ADR-007: Model gateway is provider-independent (via ai-hub)

- **Status:** Accepted (amended in v0.2.1)
- **Source:** `docs/system-design-v0.2.1.md` §15, §21; implementation-plan §2, §5.6

## Decision

All model calls go through a `ModelClient` interface in `packages/model`, implemented
with the Vercel AI SDK against an OpenAI-compatible provider pointed at ai-hub.
ai-hub owns routing, cost tracking, and async-job handling. The SDK stays *below*
the interface — it is not the architecture.

## Consequences

- Local (vLLM) and frontier models are interchangeable per-call via routing tiers.
- Amendment: guided decoding (`response_format: json_schema`) rides through ai-hub.
