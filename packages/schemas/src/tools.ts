// Tool I/O contracts (rule 2). Tool implementations live in packages/tools;
// agents/gates/console type against these.
import { z } from "zod";

export const ToolName = z.enum(["web_fetch", "web_search"]);
export type ToolName = z.infer<typeof ToolName>;

export const WebFetchInput = z.object({
  url: z.string().url(),
  timeoutMs: z.number().int().positive().max(60_000).default(20_000),
});
export type WebFetchInput = z.infer<typeof WebFetchInput>;

export const WebFetchResult = z.object({
  url: z.string(),
  status: z.number().int(),
  contentType: z.string().nullable(),
  excerpt: z.string(), // stripped text, truncated for the model
  snapshotArtifactId: z.string().uuid(), // full capture, content-addressed
});
export type WebFetchResult = z.infer<typeof WebFetchResult>;
