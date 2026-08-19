// web_fetch (ticket 2.3; Firecrawl since D4-amended): fetch a URL, snapshot
// the capture as a content-addressed page_snapshot artifact (a re-fetched
// identical page reuses the blob), return a text excerpt for the model. When
// deps.firecrawlBaseUrl is configured the page is scraped to clean MARKDOWN
// via self-hosted Firecrawl /v2/scrape (P3 gate finding: naive HTML-stripping
// of long reference pages starved the researcher); direct fetch remains the
// fallback so a Firecrawl outage degrades, never blocks.
import { CategorizedError, newId, WebFetchInput, type WebFetchResult } from "@lab/schemas";
import type { ToolDef, ToolDeps, ToolScopeContext } from "./registry";

// 16k chars ≈ 4k tokens of excerpt for the model; the full capture is truth.
const EXCERPT_CHARS = 16_000;

// Naive HTML → text: the no-Firecrawl fallback.
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

interface Capture {
  content: string; // what gets snapshotted
  excerptSource: string; // what the model sees (sliced)
  mediaType: string;
  status: number;
  via: "firecrawl" | "direct";
}

async function scrapeViaFirecrawl(
  baseUrl: string,
  url: string,
  deps: ToolDeps,
): Promise<Capture | null> {
  try {
    const res = await deps.fetchImpl(`${baseUrl.replace(/\/$/, "")}/v2/scrape`, {
      method: "POST",
      signal: AbortSignal.timeout(45_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"] }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      data?: { markdown?: string; metadata?: { statusCode?: number } };
    };
    const markdown = body.data?.markdown;
    if (!markdown || markdown.length === 0) return null;
    return {
      content: markdown,
      excerptSource: markdown,
      mediaType: "text/markdown",
      status: body.data?.metadata?.statusCode ?? 200,
      via: "firecrawl",
    };
  } catch {
    return null; // degrade to direct fetch
  }
}

async function fetchDirect(url: string, timeoutMs: number, deps: ToolDeps): Promise<Capture> {
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
  return {
    content: body,
    excerptSource: contentType?.includes("html") ? htmlToText(body) : body,
    mediaType: contentType?.split(";")[0] ?? "text/html",
    status: res.status,
    via: "direct",
  };
}

export const webFetchTool: ToolDef = {
  name: "web_fetch",
  async run(rawInput, ctx: ToolScopeContext, deps) {
    const parsed = WebFetchInput.safeParse(rawInput);
    if (!parsed.success) {
      throw new CategorizedError("TOOL_FAILURE", "web_fetch input invalid", {
        detail: parsed.error.issues,
      });
    }
    const { url, timeoutMs, startChar } = parsed.data;

    const capture =
      (deps.firecrawlBaseUrl ? await scrapeViaFirecrawl(deps.firecrawlBaseUrl, url, deps) : null) ??
      (await fetchDirect(url, timeoutMs, deps));

    const saved = await deps.store.save(deps.db, {
      id: newId(),
      runId: ctx.runId,
      taskId: ctx.taskId ?? null,
      attemptId: ctx.attemptId,
      type: "page_snapshot",
      name: url,
      mediaType: capture.mediaType,
      content: capture.content,
      createdBy: "web_fetch",
      metadata: { url, status: capture.status, via: capture.via },
    });

    const totalChars = capture.excerptSource.length;
    const output: WebFetchResult = {
      url,
      status: capture.status,
      contentType: capture.mediaType,
      excerpt: capture.excerptSource.slice(startChar, startChar + EXCERPT_CHARS),
      startChar,
      totalChars,
      snapshotArtifactId: saved.id,
    };
    return {
      output,
      snippet: `${capture.status} ${url} · chars ${startChar}-${Math.min(startChar + EXCERPT_CHARS, totalChars)}/${totalChars} via ${capture.via}${saved.deduped ? " (deduped)" : ""}`,
      artifactId: saved.id,
    };
  },
};
