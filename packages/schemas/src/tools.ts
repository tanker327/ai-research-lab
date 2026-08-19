// Tool I/O contracts (rule 2). Tool implementations live in packages/tools;
// agents/gates/console type against these.
import { z } from "zod";

export const ToolName = z.enum(["web_fetch", "web_search"]);
export type ToolName = z.infer<typeof ToolName>;

export const WebFetchInput = z.object({
  url: z.string().url(),
  timeoutMs: z.number().int().positive().max(60_000).default(20_000),
  // Long pages page through the capture (P3 gate finding: reference pages
  // bigger than one excerpt window truncated before the section that
  // mattered). 0-based char offset into the extracted text.
  startChar: z.number().int().min(0).max(5_000_000).default(0),
});
export type WebFetchInput = z.infer<typeof WebFetchInput>;

// web_search (ticket 3.3, D4): backed by self-hosted SearXNG (JSON API).
export const WebSearchInput = z.object({
  query: z.string().min(2).max(400),
  maxResults: z.number().int().positive().max(10).default(8),
});
export type WebSearchInput = z.infer<typeof WebSearchInput>;

export const WebSearchResult = z.object({
  query: z.string(),
  results: z
    .array(
      z.object({
        title: z.string().max(500),
        url: z.string().max(2000),
        snippet: z.string().max(1000),
      }),
    )
    .max(10),
});
export type WebSearchResult = z.infer<typeof WebSearchResult>;

export const WebFetchResult = z.object({
  url: z.string(),
  status: z.number().int(),
  contentType: z.string().nullable(),
  excerpt: z.string(), // extracted text window [startChar, startChar+window)
  startChar: z.number().int(),
  totalChars: z.number().int(), // of the full extracted text — more pages exist if > startChar+excerpt
  snapshotArtifactId: z.string().uuid(), // full capture, content-addressed
});
export type WebFetchResult = z.infer<typeof WebFetchResult>;
