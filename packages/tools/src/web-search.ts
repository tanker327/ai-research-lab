// web_search (ticket 3.3, phase-3-plan D4 — amended 2026-08-19): self-hosted
// Firecrawl /v2/search (SearXNG is its backend; we call Firecrawl, not
// SearXNG directly, per the deployment's contract). The tool is only
// registered when FIRECRAWL_BASE_URL is configured.
import { CategorizedError, WebSearchInput, type WebSearchResult } from "@lab/schemas";
import type { ToolDef } from "./registry";

interface FirecrawlSearchItem {
  title?: string;
  url?: string;
  description?: string;
}

export function createWebSearchTool(baseUrl: string): ToolDef {
  return {
    name: "web_search",
    async run(rawInput, _ctx, deps) {
      const parsed = WebSearchInput.safeParse(rawInput);
      if (!parsed.success) {
        throw new CategorizedError("TOOL_FAILURE", "web_search input invalid", {
          detail: parsed.error.issues,
        });
      }
      const { query, maxResults } = parsed.data;
      let res: Response;
      try {
        res = await deps.fetchImpl(`${baseUrl.replace(/\/$/, "")}/v2/search`, {
          method: "POST",
          signal: AbortSignal.timeout(30_000),
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query, limit: maxResults }),
        });
      } catch (err) {
        throw new CategorizedError("TOOL_FAILURE", `web_search failed for '${query}'`, {
          cause: err,
        });
      }
      if (!res.ok) {
        throw new CategorizedError("TOOL_FAILURE", `firecrawl search returned ${res.status}`, {
          detail: { query },
        });
      }
      const body = (await res.json()) as { data?: { web?: FirecrawlSearchItem[] } };
      const results = (body.data?.web ?? []).slice(0, maxResults).map((r) => ({
        title: (r.title ?? "").slice(0, 500),
        url: (r.url ?? "").slice(0, 2000),
        snippet: (r.description ?? "").slice(0, 1000),
      }));
      const output: WebSearchResult = { query, results };
      return {
        output,
        snippet: `${results.length} results for '${query.slice(0, 80)}'`,
        artifactId: null,
      };
    },
  };
}
