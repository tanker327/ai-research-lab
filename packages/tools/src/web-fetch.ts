// web_fetch (ticket 2.3): fetch a URL, snapshot the full body as a
// content-addressed page_snapshot artifact (a re-fetched identical page
// reuses the blob), return a stripped-text excerpt for the model. web_search
// is gated on phase-2-plan D4 (provider choice pending).
import { CategorizedError, newId, WebFetchInput, type WebFetchResult } from "@lab/schemas";
import type { ToolDef } from "./registry";

// 16k chars ≈ 4k tokens: long reference pages (e.g. postgresql.org synopsis
// pages) truncated at 4k starved the researcher (P3 gate finding).
const EXCERPT_CHARS = 16_000;

// Naive HTML → text: good enough for excerpts; the full capture is the truth.
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export const webFetchTool: ToolDef = {
  name: "web_fetch",
  async run(rawInput, ctx, deps) {
    const parsed = WebFetchInput.safeParse(rawInput);
    if (!parsed.success) {
      throw new CategorizedError("TOOL_FAILURE", "web_fetch input invalid", {
        detail: parsed.error.issues,
      });
    }
    const { url, timeoutMs } = parsed.data;

    let res: Response;
    try {
      res = await deps.fetchImpl(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "user-agent": "ai-research-lab/0.1 (+research run)" },
      });
    } catch (err) {
      throw new CategorizedError("TOOL_FAILURE", `web_fetch failed for ${url}`, { cause: err });
    }
    const body = await res.text();
    const contentType = res.headers.get("content-type");

    const saved = await deps.store.save(deps.db, {
      id: newId(),
      runId: ctx.runId,
      taskId: ctx.taskId ?? null,
      attemptId: ctx.attemptId,
      type: "page_snapshot",
      name: url,
      mediaType: contentType?.split(";")[0] ?? "text/html",
      content: body,
      createdBy: "web_fetch",
      metadata: { url, status: res.status },
    });

    const text = contentType?.includes("html") ? htmlToText(body) : body;
    const output: WebFetchResult = {
      url,
      status: res.status,
      contentType,
      excerpt: text.slice(0, EXCERPT_CHARS),
      snapshotArtifactId: saved.id,
    };
    return {
      output,
      snippet: `${res.status} ${url} · ${saved.sizeBytes}b${saved.deduped ? " (deduped)" : ""}`,
      artifactId: saved.id,
    };
  },
};
