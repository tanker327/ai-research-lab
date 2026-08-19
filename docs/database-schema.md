# AI Research Lab — Database Schema

**Version:** 1.0 (consolidates design v0.2.1 — supersedes the v0.1 §26 sketch + v0.2 §17 delta + v0.2.1 §24.7 delta)
**Date:** 2026-08-19
**Status:** Migration-ready — this DDL *is* migration `0001`
**Database:** PostgreSQL 16

---

# 1. Conventions

- **IDs:** `UUID` primary keys, generated app-side as **UUIDv7** (time-ordered → natural index locality for events/attempts). No DB-side generation.
- **Enums:** `TEXT` + `CHECK` constraints, not PG enums — additive value changes stay one-line migrations. The authoritative TS enums live in `packages/schemas`; the CHECK constraints mirror them.
- **Timestamps:** `TIMESTAMPTZ`, `now()` defaults on `created_at`. `updated_at` maintained app-side (every write goes through repositories).
- **JSONB defaults:** every metadata/payload column defaults to `'{}'::jsonb` or `'[]'::jsonb` — never NULL-checked JSON.
- **Deletion:** nothing is deleted during a run. Retirement is status-based (`SUPERSEDED`, `CANCELLED`); liveness is a view concern (§8). Whole-run deletion cascades are for GC only.
- **Ownership rule (ADR-014):** every side-effect row (`evidence`, `raw_claims`, `artifacts`, `tool_calls`, `model_calls`) carries `attempt_id`. Downstream reads go through `live_*` views, never base tables.

Required extensions:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- canonicalization candidate matching
```

---

# 2. Runs, Specs, Plan Stages

```sql
CREATE TABLE research_runs (
  id               UUID PRIMARY KEY,
  title            TEXT,
  user_request     TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'CREATED'
                   CHECK (status IN ('CREATED','PLANNING','RESEARCHING','ANALYZING',
                                     'EVALUATING','SYNTHESIZING','WAITING_HUMAN',
                                     'COMPLETED','FAILED','CANCELLED')),
  -- budget caps (design §15.3); consumption is computed from model_calls/tool_calls
  budget           JSONB NOT NULL DEFAULT '{}'::jsonb,
  eval_cycle_count INTEGER NOT NULL DEFAULT 0,          -- cycle guard counter (ADR-016)
  spec_version     INTEGER NOT NULL DEFAULT 0,          -- current version; 0 = no spec yet
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ,
  cancelled_at     TIMESTAMPTZ,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_runs_status ON research_runs (status) WHERE status NOT IN ('COMPLETED','FAILED','CANCELLED');
```

```sql
CREATE TABLE research_specs (
  id                    UUID PRIMARY KEY,
  run_id                UUID NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  version               INTEGER NOT NULL,               -- versioning semantics: design §13
  objective             TEXT NOT NULL,
  scope                 JSONB NOT NULL DEFAULT '[]'::jsonb,
  exclusions            JSONB NOT NULL DEFAULT '[]'::jsonb,
  constraints           JSONB NOT NULL DEFAULT '[]'::jsonb,
  success_criteria      JSONB NOT NULL DEFAULT '[]'::jsonb,
  key_questions         JSONB NOT NULL DEFAULT '[]'::jsonb,
  clarifications_assumed JSONB NOT NULL DEFAULT '[]'::jsonb,   -- Planner clarify stage (R1)
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, version)
);
```

```sql
-- One row per Planner invocation; holds the PlanDelta + rationale (design §7, §17)
CREATE TABLE plan_stages (
  id           UUID PRIMARY KEY,
  run_id       UUID NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  stage        INTEGER NOT NULL,
  spec_version INTEGER NOT NULL,
  delta        JSONB NOT NULL,      -- { addTasks, cancelTaskIds, supersedeTaskIds }
  rationale    TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, stage)
);
```

---

# 3. Tasks, Dependencies

```sql
CREATE TABLE research_tasks (
  id               UUID PRIMARY KEY,
  run_id           UUID NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  parent_task_id   UUID REFERENCES research_tasks(id),
  plan_stage       INTEGER NOT NULL DEFAULT 1,
  spec_version     INTEGER NOT NULL DEFAULT 1,          -- version the task was created under (§13)

  type             TEXT NOT NULL
                   CHECK (type IN ('plan','research','extract','analyze',
                                   'evaluate','synthesize','human_review')),
  title            TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'CREATED'
                   CHECK (status IN ('CREATED','READY','RUNNING','EVALUATING','DONE',
                                     'FAILED','BLOCKED','WAITING_HUMAN','CANCELLED')),
  priority         INTEGER NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),

  agent_role       TEXT NOT NULL,
  agent_version    TEXT NOT NULL DEFAULT 'v1',
  model_tier       TEXT CHECK (model_tier IN ('frontier','strong_local','fast_local','cheap_remote')),
  strategy         TEXT,                                 -- ResearchStrategy, research tasks only

  -- STAGED PLANNING INVARIANT (ADR-011): input is fully concrete at creation.
  input            JSONB NOT NULL DEFAULT '{}'::jsonb,
  success_criteria JSONB NOT NULL DEFAULT '[]'::jsonb,

  max_attempts     INTEGER NOT NULL DEFAULT 3,
  attempt_count    INTEGER NOT NULL DEFAULT 0,

  claimed_by       TEXT,
  claimed_at       TIMESTAMPTZ,
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- THE claim-query index: partial, covering exactly the hot path (§9.1)
CREATE INDEX idx_tasks_ready_claim
  ON research_tasks (priority DESC, created_at ASC)
  WHERE status = 'READY';

-- Stale-claim sweep (§9.2)
CREATE INDEX idx_tasks_running_claimed
  ON research_tasks (claimed_at)
  WHERE status = 'RUNNING';

-- Readiness sweep + general lookups
CREATE INDEX idx_tasks_run_status ON research_tasks (run_id, status);
```

```sql
CREATE TABLE task_dependencies (
  task_id            UUID NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
  depends_on_task_id UUID NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
  dependency_type    TEXT NOT NULL DEFAULT 'required' CHECK (dependency_type IN ('required')),
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id != depends_on_task_id)
);
CREATE INDEX idx_deps_reverse ON task_dependencies (depends_on_task_id);
```

Cycle prevention is app-side at insert time (walk `depends_on` transitively before commit); the DAG is small enough that a recursive CTE check in the same transaction is fine.

---

# 4. Attempts

```sql
CREATE TABLE attempts (
  id                UUID PRIMARY KEY,
  task_id           UUID NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
  run_id            UUID NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  attempt_number    INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'CREATED'
                    CHECK (status IN ('CREATED','RUNNING','SUCCEEDED','FAILED',
                                      'ACCEPTED','REJECTED','SUPERSEDED','CANCELLED')),

  agent_name        TEXT NOT NULL,
  agent_version     TEXT NOT NULL,
  model             TEXT,
  model_tier        TEXT,
  strategy          TEXT,
  infra_retry_count INTEGER NOT NULL DEFAULT 0,          -- separate axis from attempt_number

  -- R12: input is the VERBATIM Context Builder product the agent received.
  input             JSONB NOT NULL DEFAULT '{}'::jsonb,
  output            JSONB,
  error             JSONB,                                -- { category, message, detail }

  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (task_id, attempt_number)
);

-- Liveness joins hit this constantly (§8)
CREATE INDEX idx_attempts_task_status ON attempts (task_id, status);
CREATE INDEX idx_attempts_run ON attempts (run_id);

-- INVARIANT (enforced in liveness.ts, asserted in tests): at most one ACCEPTED attempt per task.
CREATE UNIQUE INDEX idx_attempts_one_accepted ON attempts (task_id) WHERE status = 'ACCEPTED';
```

That last partial unique index turns the most important application invariant into a database guarantee: a race that would double-accept fails loudly at commit.

---

# 5. Artifacts

```sql
CREATE TABLE artifacts (
  id          UUID PRIMARY KEY,
  run_id      UUID NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  task_id     UUID REFERENCES research_tasks(id),
  attempt_id  UUID REFERENCES attempts(id),

  type        TEXT NOT NULL
              CHECK (type IN ('research_note','reasoning','page_snapshot','tool_response',
                              'analysis_memo','report','other')),
  name        TEXT NOT NULL,
  media_type  TEXT NOT NULL DEFAULT 'text/markdown',
  storage_uri TEXT NOT NULL,                 -- file://{ARTIFACT_ROOT}/{run_id}/{sha256|id}
  size_bytes  BIGINT,
  sha256      TEXT,                          -- content addressing; dedup key for snapshots
  created_by  TEXT NOT NULL,                 -- agent name or 'system'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_artifacts_attempt ON artifacts (attempt_id);
CREATE INDEX idx_artifacts_run_type ON artifacts (run_id, type);
-- Content-addressed dedup: a re-fetched identical page reuses the stored blob.
CREATE UNIQUE INDEX idx_artifacts_dedup ON artifacts (run_id, sha256) WHERE sha256 IS NOT NULL;
```

`type='reasoning'` artifacts (R11) are display/debug material only — the Context Builder never selects them (ADR-018). Enforced in `packages/context`, asserted in its tests.

---

# 6. Evidence, Claims, Canonicalization

```sql
-- Facts at collection time; judgments at evaluation time (ADR-013). No score floats.
CREATE TABLE evidence (
  id                 UUID PRIMARY KEY,
  run_id             UUID NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  task_id            UUID NOT NULL REFERENCES research_tasks(id),
  attempt_id         UUID NOT NULL REFERENCES attempts(id),          -- ownership (P9)

  source_class       TEXT NOT NULL
                     CHECK (source_class IN ('official_docs','paper','independent_benchmark',
                                             'vendor_benchmark','news','community','user_supplied')),
  source_url         TEXT,
  source_title       TEXT,
  publisher          TEXT,
  author             TEXT,
  published_at       TIMESTAMPTZ,
  retrieved_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  vendor_affiliated  BOOLEAN,                -- NULL = unknown; the vendor-rule check treats NULL as vendor for safety
  benchmark_origin   TEXT,                   -- underlying benchmark/dataset identity — dedup + independence key
  excerpt            TEXT NOT NULL,
  artifact_id        UUID REFERENCES artifacts(id),      -- page snapshot
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_evidence_attempt ON evidence (attempt_id);
CREATE INDEX idx_evidence_run ON evidence (run_id);
```

```sql
-- Raw claims: attempt-owned audit records, resolved into canonical claims (design §10)
CREATE TABLE raw_claims (
  id                 UUID PRIMARY KEY,
  run_id             UUID NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  task_id            UUID NOT NULL REFERENCES research_tasks(id),
  attempt_id         UUID NOT NULL REFERENCES attempts(id),
  canonical_claim_id UUID,                   -- set by canonicalization; FK added below

  statement          TEXT NOT NULL,
  subject_key        TEXT NOT NULL,          -- normalized: 'model:qwen3.6-27b'
  predicate_key      TEXT NOT NULL,          -- normalized: 'livecodebench_v6'
  value_text         TEXT,                   -- normalized value for conflict detection
  type               TEXT NOT NULL CHECK (type IN ('fact','comparison','inference',
                                                   'recommendation','uncertainty')),
  confidence         TEXT CHECK (confidence IN ('low','medium','high')),
  created_by_agent   TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_rawclaims_attempt ON raw_claims (attempt_id);
CREATE INDEX idx_rawclaims_canonical ON raw_claims (canonical_claim_id);
CREATE INDEX idx_rawclaims_keys ON raw_claims (run_id, subject_key, predicate_key);
```

```sql
CREATE TABLE canonical_claims (
  id            UUID PRIMARY KEY,
  run_id        UUID NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  subject_key   TEXT NOT NULL,
  predicate_key TEXT NOT NULL,
  statement     TEXT NOT NULL,              -- best current phrasing
  type          TEXT NOT NULL CHECK (type IN ('fact','comparison','inference',
                                              'recommendation','uncertainty')),
  status        TEXT NOT NULL DEFAULT 'proposed'
                CHECK (status IN ('proposed','supported','contested','rejected','approved')),
  contest_note  TEXT,                       -- V0.05 contradiction representation
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, subject_key, predicate_key)
);
-- trgm candidate matching for near-dup subjects ('qwen3.6-27b' vs 'qwen-3.6 27B FP8')
CREATE INDEX idx_canonical_subject_trgm ON canonical_claims USING gin (subject_key gin_trgm_ops);

ALTER TABLE raw_claims
  ADD CONSTRAINT fk_rawclaims_canonical
  FOREIGN KEY (canonical_claim_id) REFERENCES canonical_claims(id);
```

```sql
CREATE TABLE claim_evidence_links (
  canonical_claim_id UUID NOT NULL REFERENCES canonical_claims(id) ON DELETE CASCADE,
  evidence_id        UUID NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  relation           TEXT NOT NULL CHECK (relation IN ('supports','contradicts','context')),
  PRIMARY KEY (canonical_claim_id, evidence_id)
);
CREATE INDEX idx_cel_evidence ON claim_evidence_links (evidence_id);
```

**Canonicalization contract:** runs only over `live_raw_claims` (§8); re-runs whenever the live set changes (accept/supersede enqueues it, §9.3). Canonical claims whose *every* linked raw claim went dark are re-derived — a canonical row is a pure function of the live raw set.

---

# 7. Evaluations, Decisions, Events, Calls, Checkpoints

```sql
CREATE TABLE evaluations (
  id             UUID PRIMARY KEY,
  run_id         UUID NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  target_type    TEXT NOT NULL CHECK (target_type IN ('attempt','task','analysis','report','run')),
  target_id      UUID NOT NULL,
  evaluator_type TEXT NOT NULL CHECK (evaluator_type IN ('rule','agent','human')),
  evaluator_name TEXT NOT NULL,             -- 'check:min_evidence' | 'evaluator/v1' | user id
  decision       TEXT NOT NULL,             -- ACCEPT | REJECT | RESEARCH_MORE | ...
  reasons        JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Persisted CoverageSummary for evaluator-cycle evaluations (R13/§24.2)
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_evaluations_target ON evaluations (target_type, target_id);
CREATE INDEX idx_evaluations_run ON evaluations (run_id, created_at);
```

```sql
CREATE TABLE decision_records (
  id           UUID PRIMARY KEY,
  run_id       UUID NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  task_id      UUID REFERENCES research_tasks(id),
  attempt_id   UUID REFERENCES attempts(id),
  type         TEXT NOT NULL,               -- 'retry_ladder' | 'cycle_guard' | 'budget' | 'replan' | ...
  decision     TEXT NOT NULL,
  rationale    TEXT NOT NULL,               -- human-readable; trace control-blocks render verbatim (§24.2)
  created_by   TEXT NOT NULL,               -- 'retry_coordinator' | 'run_coordinator' | agent name
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_decisions_run ON decision_records (run_id, created_at);
CREATE INDEX idx_decisions_attempt ON decision_records (attempt_id);
```

```sql
CREATE TABLE events (
  id         UUID PRIMARY KEY,              -- UUIDv7 → chronological PK scan order
  run_id     UUID NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  task_id    UUID REFERENCES research_tasks(id),
  attempt_id UUID REFERENCES attempts(id),
  type       TEXT NOT NULL,                 -- RUN_CREATED | TASK_CLAIMED | ... (design §25.1 v0.1 list)
  kind       TEXT NOT NULL DEFAULT 'info'
             CHECK (kind IN ('info','accept','gate','warn','fail')),   -- §24.3
  actor      TEXT NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_events_run_time ON events (run_id, created_at);
CREATE INDEX idx_events_attempt ON events (attempt_id);
```

```sql
CREATE TABLE model_calls (
  id                    UUID PRIMARY KEY,
  run_id                UUID NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  attempt_id            UUID NOT NULL REFERENCES attempts(id),
  model                 TEXT NOT NULL,
  model_tier            TEXT NOT NULL,
  purpose               TEXT NOT NULL DEFAULT 'agent',   -- 'agent' | 'canonical_merge' | 'validator'
  input_tokens          INTEGER,
  output_tokens         INTEGER,
  cost_usd              NUMERIC(10,6),
  latency_ms            INTEGER NOT NULL,
  finish_reason         TEXT,
  reasoning_artifact_id UUID REFERENCES artifacts(id),   -- R11
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_modelcalls_attempt ON model_calls (attempt_id);
CREATE INDEX idx_modelcalls_run ON model_calls (run_id);
```

```sql
CREATE TABLE tool_calls (
  id                   UUID PRIMARY KEY,
  run_id               UUID NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  attempt_id           UUID NOT NULL REFERENCES attempts(id),
  seq                  INTEGER NOT NULL,                 -- order within attempt (R13)
  tool_name            TEXT NOT NULL,
  request              JSONB NOT NULL,
  response_snippet     TEXT,                             -- truncated for trace display
  response_artifact_id UUID REFERENCES artifacts(id),    -- full capture
  error                JSONB,
  latency_ms           INTEGER,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, seq)
);
CREATE INDEX idx_toolcalls_attempt ON tool_calls (attempt_id, seq);
```

```sql
CREATE TABLE human_checkpoints (
  id         UUID PRIMARY KEY,
  run_id     UUID NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  task_id    UUID REFERENCES research_tasks(id),
  reason     TEXT NOT NULL,                  -- 'budget_exceeded' | 'scope_ambiguity' | 'evaluator_escalation' | 'cycle_guard'
  question   TEXT NOT NULL,
  options    JSONB NOT NULL DEFAULT '[]'::jsonb,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved','cancelled')),
  response   JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX idx_checkpoints_pending ON human_checkpoints (run_id) WHERE status = 'pending';
```

---

# 8. Liveness Views (ADR-014 made queryable)

```sql
CREATE VIEW live_evidence AS
  SELECT e.* FROM evidence e
  JOIN attempts a ON a.id = e.attempt_id
  WHERE a.status = 'ACCEPTED';

CREATE VIEW live_raw_claims AS
  SELECT rc.* FROM raw_claims rc
  JOIN attempts a ON a.id = rc.attempt_id
  WHERE a.status = 'ACCEPTED';

-- Canonical claims that still have live backing (what Analyst/Evaluator/Synthesizer see)
CREATE VIEW live_canonical_claims AS
  SELECT cc.* FROM canonical_claims cc
  WHERE EXISTS (SELECT 1 FROM live_raw_claims lrc WHERE lrc.canonical_claim_id = cc.id);

-- Claim bundle for the Context Builder: claim + its live evidence via links
CREATE VIEW live_claim_evidence AS
  SELECT cel.canonical_claim_id, cel.relation, le.*
  FROM claim_evidence_links cel
  JOIN live_evidence le ON le.id = cel.evidence_id;
```

**Rule:** `packages/context`, `packages/evidence` (coverage computation), and every read API query the views. Base-table reads outside `packages/db` repositories and the trace assembler are a code-review reject.

---

# 9. Hot Query Patterns (raw SQL, never ORM)

## 9.1 Atomic claim — served entirely by `idx_tasks_ready_claim`

```sql
SELECT id FROM research_tasks
WHERE status = 'READY'
ORDER BY priority DESC, created_at ASC
FOR UPDATE SKIP LOCKED
LIMIT 1;
```

## 9.2 Stale-claim sweep (scheduler, every 30s)

```sql
UPDATE research_tasks
SET status = 'READY', claimed_by = NULL, claimed_at = NULL, updated_at = now()
WHERE status = 'RUNNING' AND claimed_at < now() - make_interval(secs => $1)
RETURNING id;
-- for each returned id: mark its RUNNING attempt FAILED('TRANSIENT_INFRA') + event(kind='warn')
```

## 9.3 Readiness sweep (scheduler, every POLL_INTERVAL)

```sql
UPDATE research_tasks t
SET status = 'READY', updated_at = now()
WHERE t.status = 'CREATED'
  AND NOT EXISTS (
    SELECT 1 FROM task_dependencies d
    JOIN research_tasks dep ON dep.id = d.depends_on_task_id
    WHERE d.task_id = t.id AND dep.status != 'DONE')
  AND EXISTS (SELECT 1 FROM research_runs r WHERE r.id = t.run_id
              AND r.status NOT IN ('COMPLETED','FAILED','CANCELLED','WAITING_HUMAN'))
RETURNING id;
-- separately: tasks whose deps include a FAILED task → BLOCKED
```

## 9.4 Coverage aggregation (deterministic, feeds the Evaluator)

```sql
SELECT
  count(*)                                        AS evidence_count,
  count(DISTINCT publisher)                       AS distinct_publishers,
  count(DISTINCT benchmark_origin)
    FILTER (WHERE benchmark_origin IS NOT NULL)   AS distinct_origins,
  avg(CASE WHEN vendor_affiliated IS DISTINCT FROM false THEN 1.0 ELSE 0.0 END)
                                                  AS vendor_ratio   -- NULL counted as vendor (safety)
FROM live_evidence WHERE run_id = $1;
-- per-key-question variant filters via a claim→key_question mapping in claim metadata
```

## 9.5 Provenance walk (report chip → source)

```sql
SELECT cc.statement, cel.relation, le.excerpt, le.source_url, le.source_class,
       le.publisher, a.id AS attempt_id, t.id AS task_id, t.title
FROM canonical_claims cc
JOIN claim_evidence_links cel ON cel.canonical_claim_id = cc.id
JOIN live_evidence le ON le.id = cel.evidence_id
JOIN attempts a ON a.id = le.attempt_id
JOIN research_tasks t ON t.id = le.task_id
WHERE cc.id = ANY($1);          -- claim ids from the citation map
```

## 9.6 Trace assembly (read API)

Four indexed fetches merged app-side by timestamp/seq — no join gymnastics:
`attempts(id)` → `tool_calls(attempt_id, seq)` → `model_calls(attempt_id)` + reasoning artifacts → `events(attempt_id)` + `decision_records(attempt_id)`.

---

# 10. Drizzle Notes

- All tables defined in `packages/db/src/schema/*.ts`; this document and the Drizzle schema are kept in lockstep — a drift is a PR blocker.
- Views are created in raw-SQL migration steps (`sql` template in the migration file); Drizzle models them read-only via `pgView`.
- CHECK constraints live in migrations; the matching Zod enums in `packages/schemas` are the single TS source.
- §9 queries live in `packages/db/src/raw/` as tagged-template functions with typed row mappers — imported by `packages/core`, never inlined elsewhere.

---

# 11. GC & Retention (defined now, implemented later)

Whole-run deletion: `DELETE FROM research_runs WHERE id = $1` cascades everything; artifact blobs are swept by a script comparing `ARTIFACT_ROOT` against `artifacts.storage_uri`. Retention policy (e.g. drop `tool_response` artifacts after 90 days, keep everything else) is a V0.1 concern — the `type` column already supports it.
