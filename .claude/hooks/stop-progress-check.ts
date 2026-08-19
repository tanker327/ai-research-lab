#!/usr/bin/env bun
// Stop hook: progress hygiene. The progress-tracking rule says "never leave a
// task in_progress when ending a session" — this is the mechanical reminder.
// If progress/current.json has an in_progress task when Claude tries to stop,
// block the stop ONCE (exit 2, stderr becomes an instruction to Claude) so the
// task gets completed or set back to pending/blocked.
//
// Loop safety (a Stop hook that always blocks would ping-pong forever):
//   - stop_hook_active=true in the input means we already blocked this stop
//     chain once → allow.
//   - a per-session marker file means we already reminded this session → allow
//     (the agent may legitimately leave the task in_progress after telling the
//     user why; we nag once, not every turn).
// Always fails open on any error.

import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

try {
  const input = JSON.parse(await Bun.stdin.text());
  if (input.stop_hook_active) process.exit(0);

  const file = Bun.file("progress/current.json");
  if (!(await file.exists())) process.exit(0);
  const d = JSON.parse(await file.text());
  const inProgress = (d.tasks ?? []).filter((t: { status?: string }) => t.status === "in_progress");
  if (inProgress.length === 0) process.exit(0);

  const marker = join(tmpdir(), `skl-stop-reminded-${input.session_id ?? "unknown"}`);
  if (existsSync(marker)) process.exit(0);
  writeFileSync(marker, new Date().toISOString());

  const ids = inProgress
    .map((t: { id?: string; title?: string }) => `${t.id} — ${t.title}`)
    .join("; ");
  console.error(
    `progress/current.json still has in_progress task(s): ${ids}. Per .claude/rules/progress-tracking.md, before ending the session either complete it (status "completed" + completed_at + commit) or set it back to "pending"/"blocked" with a note. If you already discussed leaving it with the user, briefly confirm and stop.`,
  );
  process.exit(2);
} catch {
  process.exit(0);
}
