#!/usr/bin/env bash
# Phase 0 gate (implementation-plan §6): migrate + tests green, api/worker boot
# and connect. Run from repo root with postgres up. A phase is done when this
# passes in CI, not when the code "looks done."
set -euo pipefail

export DATABASE_URL="${DATABASE_URL:-postgres://lab:lab@localhost:5434/research_lab}"
# AIHUB_*/MODEL_* have config defaults since P2.1; the gate makes no model calls.

echo "→ migrate"
bun run migrate
echo "→ check (lint, import-lint, typecheck, tests)"
bun run check
echo "→ api boot"
API_BOOT_ONLY=1 bun apps/api/src/index.ts
echo "→ worker boot"
WORKER_RUN_ONCE=1 bun apps/worker/src/main.ts
echo "✓ Phase 0 gate passed"
