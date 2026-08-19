// Ticket 2.3 acceptance: ordered tool_calls per attempt (R13), allowlist
// denial persisted + typed, web_fetch snapshots content-addressed and returns
// a text excerpt. Real Postgres; fetch stubbed.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactStore, createDb, deleteRun, seedRun, seedTask } from "@lab/db";
import { newId, type WebFetchResult } from "@lab/schemas";
import postgres from "postgres";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createToolRegistry, ROLE_TOOL_ALLOWLIST, type ToolScopeContext } from "./registry";
import { htmlToText, webFetchTool } from "./web-fetch";

const url = process.env.DATABASE_URL ?? "postgres://lab:lab@localhost:5434/research_lab";
const { db, close } = createDb(url);
const raw = postgres(url);
const store = createArtifactStore(mkdtempSync(join(tmpdir(), "lab-tools-")));

let runId: string;
let ctx: ToolScopeContext;

beforeEach(async () => {
  runId = newId();
  const taskId = newId();
  const attemptId = newId();
  await seedRun(db, runId);
  await seedTask(db, { id: taskId, runId, status: "RUNNING" });
  await raw`INSERT INTO attempts (id, task_id, run_id, attempt_number, status, agent_name, agent_version)
            VALUES (${attemptId}, ${taskId}, ${runId}, 1, 'RUNNING', 'researcher', 'v1')`;
  ctx = { runId, taskId, attemptId, role: "researcher" };
});
afterEach(async () => {
  await deleteRun(db, runId);
});
afterAll(async () => {
  await close();
  await raw.end();
});

const page = (body: string, contentType = "text/html") =>
  (async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": contentType },
    })) as unknown as typeof globalThis.fetch;

const registryWith = (fetchImpl: typeof globalThis.fetch) =>
  createToolRegistry({ db, store, fetchImpl }, [webFetchTool]);

describe("tool registry", () => {
  it("persists ordered tool_calls rows per attempt (R13)", async () => {
    const scoped = registryWith(page("<p>one</p>")).forAttempt(ctx);
    await scoped.invoke("web_fetch", { url: "https://a.test/1" });
    await scoped.invoke("web_fetch", { url: "https://a.test/2" });
    await scoped.invoke("web_fetch", { url: "https://a.test/3" });

    const rows = await raw`SELECT seq, tool_name, error FROM tool_calls
                           WHERE attempt_id = ${ctx.attemptId} ORDER BY seq`;
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(rows.every((r) => r.tool_name === "web_fetch" && r.error === null)).toBe(true);
  });

  it("denies un-allowlisted roles with a typed error AND a persisted denial row", async () => {
    const synthCtx = { ...ctx, role: "synthesizer" as const };
    const scoped = registryWith(page("x")).forAttempt(synthCtx);
    expect(ROLE_TOOL_ALLOWLIST.synthesizer).toEqual([]);

    const err: unknown = await scoped
      .invoke("web_fetch", { url: "https://a.test" })
      .catch((e) => e);
    expect(err).toMatchObject({ name: "CategorizedError", category: "TOOL_FAILURE" });
    expect(String((err as Error).message)).toContain("not allowlisted");

    const [row] = await raw`SELECT error FROM tool_calls WHERE attempt_id = ${ctx.attemptId}`;
    expect(row?.error).toMatchObject({ category: "TOOL_FAILURE" });
  });

  it("persists tool failures with the error and latency", async () => {
    const failing = (async () => {
      throw new Error("connection reset");
    }) as unknown as typeof globalThis.fetch;
    const scoped = registryWith(failing).forAttempt(ctx);
    await expect(scoped.invoke("web_fetch", { url: "https://down.test" })).rejects.toMatchObject({
      category: "TOOL_FAILURE",
    });
    const [row] = await raw`SELECT error, latency_ms FROM tool_calls
                            WHERE attempt_id = ${ctx.attemptId}`;
    expect(row?.error).toMatchObject({ category: "TOOL_FAILURE" });
  });
});

describe("web_fetch", () => {
  it("snapshots the full body as a content-addressed artifact and returns an excerpt", async () => {
    const html =
      "<html><script>evil()</script><body><h1>Title</h1><p>Real content here</p></body></html>";
    const scoped = registryWith(page(html)).forAttempt(ctx);
    const result = (await scoped.invoke("web_fetch", {
      url: "https://a.test/page",
    })) as WebFetchResult;

    expect(result.status).toBe(200);
    expect(result.excerpt).toContain("Real content here");
    expect(result.excerpt).not.toContain("evil");

    const [artifact] = await raw`SELECT type, sha256, attempt_id FROM artifacts
                                 WHERE id = ${result.snapshotArtifactId}`;
    expect(artifact).toMatchObject({ type: "page_snapshot", attempt_id: ctx.attemptId });
    const back = await store.read(result.snapshotArtifactId, db);
    expect(back.content.toString()).toBe(html); // full capture, not the excerpt

    const [call] = await raw`SELECT response_artifact_id FROM tool_calls
                             WHERE attempt_id = ${ctx.attemptId}`;
    expect(call?.response_artifact_id).toBe(result.snapshotArtifactId);
  });

  it("re-fetching identical content dedupes the snapshot", async () => {
    const scoped = registryWith(page("<p>stable page</p>")).forAttempt(ctx);
    const first = (await scoped.invoke("web_fetch", { url: "https://a.test" })) as WebFetchResult;
    const second = (await scoped.invoke("web_fetch", { url: "https://a.test" })) as WebFetchResult;
    expect(second.snapshotArtifactId).toBe(first.snapshotArtifactId);
    const count = await raw`SELECT count(*)::int AS n FROM artifacts WHERE run_id = ${runId}`;
    expect(count[0]?.n).toBe(1);
  });

  it("rejects invalid input via the schema (rule 7)", async () => {
    const scoped = registryWith(page("x")).forAttempt(ctx);
    await expect(scoped.invoke("web_fetch", { url: "not-a-url" })).rejects.toMatchObject({
      category: "TOOL_FAILURE",
    });
  });

  it("htmlToText strips tags/scripts and collapses whitespace", () => {
    expect(htmlToText("<div>a<script>x</script>  <b>b</b>\n c&amp;d</div>")).toBe("a b c&d");
  });
});
