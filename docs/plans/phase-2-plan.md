# Phase 2 Plan — Model Gateway + Tools

**Status:** Draft for review 2026-08-19 · **Source tickets:** implementation-plan §6 Phase 2 · **Interfaces:** implementation-plan §5.6
**Thesis:** by the end of this phase, a stubbed "test agent" can make structured, budgeted, fully-persisted model calls and tool calls through ai-hub — with every call owned by an `attempt_id` and visible in the console. Still no real agent prompts (Phase 3).

---

## Pre-flight findings (ticket 2.0, ran 2026-08-19)

Verified against the **deployed ai-hub at `http://192.168.10.114`** (docs at `/docs`; OpenAI-compatible `/v1`; auth = `x-service-name` header, no bearer key):

| Path | Result |
|---|---|
| `local-llm/local` + `response_format: json_schema` | ✅ valid constrained JSON (enums, required, additionalProperties honored) — ADR-012 viable |
| `local-llm/local` + tool calling | ✅ `tool_calls` + `finish_reason: tool_calls` |
| `deepseek/*` auth | ✅ works |
| `deepseek/*` + `json_schema` | ❌ upstream 400 "response_format type is unavailable" |
| `openai/*` | ❌ 401 — hub's key is a placeholder |
| `xai/*` | ❌ 400 — hub's key invalid |
| Hub aliases | `default`/`free` → local-llm/local · `faster` → xai/grok-4.5 · `best` → openai/gpt-5.6-sol · `cheapest` → deepseek/deepseek-v4-flash |

Stale assumptions corrected: the Tailscale GPU box (`power-linux`) is offline (11 days) but irrelevant — the deployed hub's local model is alive. The model names in implementation-plan §4 (`claude-opus-4-8`, `qwen3.6-27b-fp8`, `qwen3.5-7b`) do not exist on the hub; we bind to **hub aliases**, not raw model ids. Running ai-hub locally uses port 8787 (collides with our api) — we use the deployed hub, so no conflict.

**USER ACTION NEEDED (blocks the frontier tier, not this phase's start):** set real OpenAI and/or xAI keys on the deployed hub. Phase 2's gate can pass against `strong_local` + `cheapest`; Phase 4's tier-escalation ladder needs a working frontier before it can be exercised live.

## Design decisions (settled before coding)

### D1 — Tier → hub-alias mapping; config speaks aliases
`MODEL_FRONTIER=best`, `MODEL_STRONG_LOCAL=default`, `MODEL_FAST_LOCAL=cheapest` (defaults; env-overridable). The hub owns which concrete model backs an alias — model swaps never touch our code. `AIHUB_API_KEY` is replaced by `AIHUB_SERVICE_NAME=research-lab` (the hub's auth scheme); `AIHUB_BASE_URL` defaults to `http://192.168.10.114/v1`. `model_calls` rows record the *resolved* model id from the response, not the alias.

### D2 — Structured-output strategy is per-provider capability, not global
`generateStructured` consults a capability table: `json_schema` where supported (local, openai when keyed), fallback `json_object` + Zod-parse for deepseek (parse failure = `SCHEMA_FAILURE`, the ladder already handles it). The capability table lives in the router policy (2.2) so Phase 3 agents never know the difference.

### D3 — Concurrency cap is client-side in `packages/model`
The implementation plan says "gateway-side semaphore," but we don't want a hub deploy in this phase's critical path: a per-tier semaphore (`GPU_CONCURRENCY_STRONG_LOCAL`) inside ModelClient bounds in-flight local calls; the hub's own queueing remains the backstop. Revisit gateway-side enforcement if a second consumer of the hub appears.

### D4 — Web search provider: **OPEN — needs user input**
`web_search` (2.3) needs a search API (Brave / Serper / SearXNG / other). No key exists in this repo today. Ticket 2.3 starts with `web_fetch` (no key needed); search lands when the user picks a provider.

## Sessions and tickets

### Session A — ModelClient (ticket 2.1)
`packages/model`: `ModelClient` per §5.6 via AI SDK `@ai-sdk/openai-compatible` → hub. `generateText` / `generateStructured` / tool-loop support; every call writes a `model_calls` row (attempt_id, resolved model, usage, latency, cost from hub headers) in the caller's transaction scope; reasoning content persisted as `type='reasoning'` artifacts — never fed back into context (ADR-018, rule 9). Errors map to the taxonomy (429/5xx → TRANSIENT_INFRA, 401/404 → PERMANENT_INFRA, schema parse → SCHEMA_FAILURE).
**Accept:** contract tests with a stubbed fetch (schema in/out, error mapping, persistence rows); one live smoke script against `default` (manual, `scripts/golden/`-style).

### Session B — Router policy (ticket 2.2)
Policy table (role → tier → alias + capability flags per D2) in `packages/model`; client-side semaphore per D3. Rule 2: the policy row shape lives in `@lab/schemas`.
**Accept:** unit tests — role resolution, fallback when a tier is unkeyed (frontier → error naming the missing key, never silent downgrade), semaphore bounds concurrent local calls under a race test.

### Session C — Artifacts + tools (tickets 2.4, 2.3)
2.4 first: content-addressed artifact store (`ARTIFACT_ROOT`, sha256 path, dedupe on identical content; row in `artifacts` with attempt_id). Then 2.3: `packages/tools` — `web_fetch` (fetch → snapshot artifact → excerpt), registry with per-role allowlists (violation = typed error, event `kind:'warn'`), ordered `tool_calls` rows via `seq`. `web_search` gated on D4.
**Accept:** store round-trip + dedupe test; fetch persists snapshot + ordered tool_calls; allowlist denial test.

### Session D — Console wiring + gate (ticket 2.5)
Run inspector gains a model/tool call panel: per-attempt `model_calls` (model, tokens, cost, latency) and `tool_calls` (seq, tool, status) via new read endpoints. Placeholder panels stay for P3+.
**Gate — `scripts/gates/p2.ts`:** a stub "test agent" task handler makes one `generateStructured` call against `strong_local` **and** one against the best available keyed tier, with a deliberately nasty schema (nested unions, enums, minItems); tool call with snapshot persisted and ordered; all rows carry attempt_id; calls visible in the console. Frontier leg runs against `best` if keys are fixed by then, else recorded as pending in the gate output (not silently skipped).

## Out of scope
Real agent prompts/roles (P3) · canonicalization (P3) · budget *enforcement* (P4) · web_search until D4 resolves · any hub-side code changes.

## Definition of done
All tickets merged with tests; `bun run gate:p2` green; `bun run check` green; tracker updated. **Audit (per standing rule): every changed module has direct tests; docs greped for invalidated statements (implementation-plan §4 env table, §5.6, CLAUDE.md commands, .env.example) and synced in the same commits.**
