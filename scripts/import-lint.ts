#!/usr/bin/env bun
// Import-lint: enforces the two commit-one rules from implementation-plan §3
// (CLAUDE.md hard rules 1 and 2):
//   1. packages/core imports nothing from @lab/agents, @lab/model, @lab/tools
//      (the control plane must be testable with zero LLM involvement).
//   2. Agent I/O contracts live only in packages/schemas — no workspace other
//      than @lab/schemas may declare a `zod` dependency-free schema module that
//      other workspaces import for agent contracts. Mechanically we approximate
//      rule 2's checkable half: nothing imports from another workspace's src/
//      via a relative path that escapes its own package.
// Exit 1 on violation; CI and `bun run check` treat that as failure.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']|\b(?:require|import)\(\s*["']([^"']+)["']\s*\)/g;

function importsOf(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const specs: string[] = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec) specs.push(spec);
  }
  return specs;
}

const violations: string[] = [];

// Rule 1: core isolation.
const CORE_FORBIDDEN = ["@lab/agents", "@lab/model", "@lab/tools"];
for (const file of tsFiles(join(ROOT, "packages/core/src"))) {
  for (const spec of importsOf(file)) {
    if (CORE_FORBIDDEN.some((f) => spec === f || spec.startsWith(`${f}/`))) {
      violations.push(
        `${relative(ROOT, file)}: imports forbidden package "${spec}" (core isolation, CLAUDE.md rule 1)`,
      );
    }
    if (/^\.\..*\/(agents|model|tools)\//.test(spec)) {
      violations.push(
        `${relative(ROOT, file)}: relative import "${spec}" escapes core into a forbidden package`,
      );
    }
  }
}

// Rule 2 (checkable half): no workspace reaches into another workspace's src/ by relative path.
for (const ws of ["packages", "apps"]) {
  const wsDir = join(ROOT, ws);
  for (const pkg of readdirSync(wsDir)) {
    const srcDir = join(wsDir, pkg, "src");
    let files: string[];
    try {
      files = tsFiles(srcDir);
    } catch {
      continue;
    }
    for (const file of files) {
      for (const spec of importsOf(file)) {
        if (/^(\.\.\/)+(packages|apps)\//.test(spec)) {
          violations.push(
            `${relative(ROOT, file)}: relative cross-package import "${spec}" — import the workspace package (@lab/*) instead`,
          );
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error("import-lint FAILED:");
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log("import-lint OK");
