// web_search (ticket 3.3, phase-3-plan D4): self-hosted SearXNG JSON API.
// The tool is only registered when SEARXNG_BASE_URL is configured — the
// researcher's step schema follows what the registry actually offers.
import { CategorizedError, WebSearchInput, type WebSearchResult } from "@lab/schemas";
import type { ToolDef } from "./registry";

interface SearxngResult {
  title?: string;
  url?: string;
  content?: string;
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
      const url = `${baseUrl.replace(/\/$/, "")}/search?q=${encodeURIComponent(query)}&format=json`;
      let res: Response;
      try {
        res = await deps.fetchImpl(url, {
          signal: AbortSignal.timeout(20_000),
          headers: { accept: "application/json" },
        });
      } catch (err) {
        throw new CategorizedError("TOOL_FAILURE", `web_search failed for '${query}'`, {
          cause: err,
        });
      }
      if (!res.ok) {
        throw new CategorizedError("TOOL_FAILURE", `searxng returned ${res.status}`, {
          detail: { query },
        });
      }
      const body = (await res.json()) as { results?: SearxngResult[] };
      const results = (body.results ?? []).slice(0, maxResults).map((r) => ({
        title: (r.title ?? "").slice(0, 500),
        url: (r.url ?? "").slice(0, 2000),
        snippet: (r.content ?? "").slice(0, 1000),
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
