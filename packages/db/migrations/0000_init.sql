-- Migration 0001 (file 0000_init): full v0.2.1 schema.
-- Source of truth: docs/database-schema.md — this file is that DDL verbatim.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE research_runs (
  id               UUID PRIMARY KEY,
  title            TEXT,
  user_request     TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'CREATED'
                   CHECK (status IN ('CREATED','PLANNING','RESEARCHING','ANALYZING',
                                     'EVALUATING','SYNTHESIZING','WAITING_HUMAN',
                                     'COMPLETED','FAILED','CANCELLED')),
  budget           JSONB NOT NULL DEFAULT '{}'::jsonb,
  eval_cycle_count INTEGER NOT NULL DEFAULT 0,
  spec_version     INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ,
  cancelled_at     TIMESTAMPTZ,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE INDEX idx_runs_status ON research_runs (status) WHERE status NOT IN ('COMPLETED','FAILED','CANCELLED');
--> statement-breakpoint
CREATE TABLE research_specs (
  id                    UUID PRIMARY KEY,
  run_id                UUID NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  version               INTEGER NOT NULL,
  objective             TEXT NOT NULL,
  scope                 JSONB NOT NULL DEFAULT '[]'::jsonb,
  exclusions            JSONB NOT NULL DEFAULT '[]'::jsonb,
  constraints           JSONB NOT NULL DEFAULT '[]'::jsonb,
  success_criteria      JSONB NOT NULL DEFAULT '[]'::jsonb,
  key_questions         JSONB NOT NULL DEFAULT '[]'::jsonb,
  clarifications_assumed JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, version)
);
--> statement-breakpoint
CREATE TABLE plan_stages (
  id           UUID PRIMARY KEY,
  run_id       UUID NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  stage        INTEGER NOT NULL,
  spec_version INTEGER NOT NULL,
  delta        JSONB NOT NULL,
  rationale    TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, stage)
);
--> statement-breakpoint
CREATE TABLE research_tasks (
  id               UUID PRIMARY KEY,
  run_id           UUID NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  parent_task_id   UUID REFERENCES research_tasks(id),
  plan_stage       INTEGER NOT NULL DEFAULT 1,
  spec_version     INTEGER NOT NULL DEFAULT 1,
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
  strategy         TEXT,
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
--> statement-breakpoint
CREATE INDEX idx_tasks_ready_claim
  ON research_tasks (priority DESC, created_at ASC)
  WHERE status = 'READY';
--> statement-breakpoint
CREATE INDEX idx_tasks_running_claimed
  ON research_tasks (claimed_at)
  WHERE status = 'RUNNING';
--> statement-breakpoint
CREATE INDEX idx_tasks_run_status ON research_tasks (run_id, status);
--> statement-breakpoint
CREATE TABLE task_dependencies (
  task_id            UUID NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
  depends_on_task_id UUID NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
  dependency_type    TEXT NOT NULL DEFAULT 'required' CHECK (dependency_type IN ('required')),
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id != depends_on_task_id)
);
--> statement-breakpoint
CREATE INDEX idx_deps_reverse ON task_dependencies (depends_on_task_id);
--> statement-breakpoint
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
  infra_retry_count INTEGER NOT NULL DEFAULT 0,
  input             JSONB NOT NULL DEFAULT '{}'::jsonb,
  output            JSONB,
  error             JSONB,
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (task_id, attempt_number)
);
--> statement-breakpoint
CREATE INDEX idx_attempts_task_status ON attempts (task_id, status);
--> statement-breakpoint
CREATE INDEX idx_attempts_run ON attempts (run_id);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_attempts_one_accepted ON attempts (task_id) WHERE status = 'ACCEPTED';
--> statement-breakpoint
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
  storage_uri TEXT NOT NULL,
  size_bytes  BIGINT,
  sha256      TEXT,
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE INDEX idx_artifacts_attempt ON artifacts (attempt_id);
--> statement-breakpoint
CREATE INDEX idx_artifacts_run_type ON artifacts (run_id, type);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_artifacts_dedup ON artifacts (run_id, sha256) WHERE sha256 IS NOT NULL;
--> statement-breakpoint
CREATE TABLE evidence (
  id                 UUID PRIMARY KEY,
  run_id             UUID NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  task_id            UUID NOT NULL REFERENCES research_tasks(id),
  attempt_id         UUID NOT NULL REFERENCES attempts(id),
  source_class       TEXT NOT NULL
                     CHECK (source_class IN ('official_docs','paper','independent_benchmark',
                                             'vendor_benchmark','news','community','user_supplied')),
  source_url         TEXT,
  source_title       TEXT,
  publisher          TEXT,
  author             TEXT,
  published_at       TIMESTAMPTZ,
  retrieved_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  vendor_affiliated  BOOLEAN,
  benchmark_origin   TEXT,
  excerpt            TEXT NOT NULL,
  artifact_id        UUID REFERENCES artifacts(id),
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE INDEX idx_evidence_attempt ON evidence (attempt_id);
--> statement-breakpoint
CREATE INDEX idx_evidence_run ON evidence (run_id);
--> statement-breakpoint
CREATE TABLE raw_claims (
  id                 UUID PRIMARY KEY,
  run_id             UUID NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  task_id            UUID NOT NULL REFERENCES research_tasks(id),
  attempt_id         UUID NOT NULL REFERENCES attempts(id),
  canonical_claim_id UUID,
  statement          TEXT NOT NULL,
  subject_key        TEXT NOT NULL,
  predicate_key      TEXT NOT NULL,
  value_text         TEXT,
  type               TEXT NOT NULL CHECK (type IN ('fact','comparison','inference',
                                                   'recommendation','uncertainty')),
  confidence         TEXT CHECK (confidence IN ('low','medium','high')),
  created_by_agent   TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX idx_rawclaims_attempt ON raw_claims (attempt_id);
--> statement-breakpoint
CREATE INDEX idx_rawclaims_canonical ON raw_claims (canonical_claim_id);
--> statement-breakpoint
CREATE INDEX idx_rawclaims_keys ON raw_claims (run_id, subject_key, predicate_key);
--> statement-breakpoint
CREATE TABLE canonical_claims (
  id            UUID PRIMARY KEY,
  run_id        UUID NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  subject_key   TEXT NOT NULL,
  predicate_key TEXT NOT NULL,
  statement     TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('fact','comparison','inference',
                                              'recommendation','uncertainty')),
  status        TEXT NOT NULL DEFAULT 'proposed'
                CHECK (status IN ('proposed','supported','contested','rejected','approved')),
  contest_note  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, subject_key, predicate_key)
);
--> statement-breakpoint
CREATE INDEX idx_canonical_subject_trgm ON canonical_claims USING gin (subject_key gin_trgm_ops);
--> statement-breakpoint
ALTER TABLE raw_claims
  ADD CONSTRAINT fk_rawclaims_canonical
  FOREIGN KEY (canonical_claim_id) REFERENCES canonical_claims(id);
--> statement-breakpoint
CREATE TABLE claim_evidence_links (
  canonical_claim_id UUID NOT NULL REFERENCES canonical_claims(id) ON DELETE CASCADE,
  evidence_id        UUID NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  relation           TEXT NOT NULL CHECK (relation IN ('supports','contradicts','context')),
  PRIMARY KEY (canonical_claim_id, evidence_id)
);
--> statement-breakpoint
CREATE INDEX idx_cel_evidence ON claim_evidence_links (evidence_id);
--> statement-breakpoint
CREATE TABLE evaluations (
  id             UUID PRIMARY KEY,
  run_id         UUID NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  target_type    TEXT NOT NULL CHECK (target_type IN ('attempt','task','analysis','report','run')),
  target_id      UUID NOT NULL,
  evaluator_type TEXT NOT NULL CHECK (evaluator_type IN ('rule','agent','human')),
  evaluator_name TEXT NOT NULL,
  decision       TEXT NOT NULL,
  reasons        JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX idx_evaluations_target ON evaluations (target_type, target_id);
--> statement-breakpoint
CREATE INDEX idx_evaluations_run ON evaluations (run_id, created_at);
--> statement-breakpoint
CREATE TABLE decision_records (
  id           UUID PRIMARY KEY,
  run_id       UUID NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  task_id      UUID REFERENCES research_tasks(id),
  attempt_id   UUID REFERENCES attempts(id),
  type         TEXT NOT NULL,
  decision     TEXT NOT NULL,
  rationale    TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE INDEX idx_decisions_run ON decision_records (run_id, created_at);
--> statement-breakpoint
CREATE INDEX idx_decisions_attempt ON decision_records (attempt_id);
--> statement-breakpoint
CREATE TABLE events (
  id         UUID PRIMARY KEY,
  run_id     UUID NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  task_id    UUID REFERENCES research_tasks(id),
  attempt_id UUID REFERENCES attempts(id),
  type       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'info'
             CHECK (kind IN ('info','accept','gate','warn','fail')),
  actor      TEXT NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX idx_events_run_time ON events (run_id, created_at);
--> statement-breakpoint
CREATE INDEX idx_events_attempt ON events (attempt_id);
--> statement-breakpoint
CREATE TABLE model_calls (
  id                    UUID PRIMARY KEY,
  run_id                UUID NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  attempt_id            UUID NOT NULL REFERENCES attempts(id),
  model                 TEXT NOT NULL,
  model_tier            TEXT NOT NULL,
  purpose               TEXT NOT NULL DEFAULT 'agent',
  input_tokens          INTEGER,
  output_tokens         INTEGER,
  cost_usd              NUMERIC(10,6),
  latency_ms            INTEGER NOT NULL,
  finish_reason         TEXT,
  reasoning_artifact_id UUID REFERENCES artifacts(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX idx_modelcalls_attempt ON model_calls (attempt_id);
--> statement-breakpoint
CREATE INDEX idx_modelcalls_run ON model_calls (run_id);
--> statement-breakpoint
CREATE TABLE tool_calls (
  id                   UUID PRIMARY KEY,
  run_id               UUID NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  attempt_id           UUID NOT NULL REFERENCES attempts(id),
  seq                  INTEGER NOT NULL,
  tool_name            TEXT NOT NULL,
  request              JSONB NOT NULL,
  response_snippet     TEXT,
  response_artifact_id UUID REFERENCES artifacts(id),
  error                JSONB,
  latency_ms           INTEGER,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, seq)
);
--> statement-breakpoint
CREATE INDEX idx_toolcalls_attempt ON tool_calls (attempt_id, seq);
--> statement-breakpoint
CREATE TABLE human_checkpoints (
  id         UUID PRIMARY KEY,
  run_id     UUID NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  task_id    UUID REFERENCES research_tasks(id),
  reason     TEXT NOT NULL,
  question   TEXT NOT NULL,
  options    JSONB NOT NULL DEFAULT '[]'::jsonb,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved','cancelled')),
  response   JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
--> statement-breakpoint
CREATE INDEX idx_checkpoints_pending ON human_checkpoints (run_id) WHERE status = 'pending';
--> statement-breakpoint
CREATE VIEW live_evidence AS
  SELECT e.* FROM evidence e
  JOIN attempts a ON a.id = e.attempt_id
  WHERE a.status = 'ACCEPTED';
--> statement-breakpoint
CREATE VIEW live_raw_claims AS
  SELECT rc.* FROM raw_claims rc
  JOIN attempts a ON a.id = rc.attempt_id
  WHERE a.status = 'ACCEPTED';
--> statement-breakpoint
CREATE VIEW live_canonical_claims AS
  SELECT cc.* FROM canonical_claims cc
  WHERE EXISTS (SELECT 1 FROM live_raw_claims lrc WHERE lrc.canonical_claim_id = cc.id);
--> statement-breakpoint
CREATE VIEW live_claim_evidence AS
  SELECT cel.canonical_claim_id, cel.relation, le.*
  FROM claim_evidence_links cel
  JOIN live_evidence le ON le.id = cel.evidence_id;
