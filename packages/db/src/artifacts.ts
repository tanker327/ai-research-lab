// Content-addressed artifact store (ticket 2.4): local fs blobs keyed by
// sha256 under ARTIFACT_ROOT/{runId}/, rows in the artifacts table. The
// partial unique index idx_artifacts_dedup makes a re-stored identical blob
// (same run) reuse the existing row — the fs write is idempotent by name.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactType } from "@lab/schemas";
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "./client";

export interface SaveArtifact {
  id: string; // caller supplies (uuidv7 via @lab/schemas newId)
  runId: string;
  taskId?: string | null;
  attemptId?: string | null;
  type: ArtifactType;
  name: string;
  mediaType?: string;
  content: string | Uint8Array;
  createdBy: string;
  metadata?: Record<string, unknown>;
}

export interface SavedArtifact {
  id: string;
  sha256: string;
  storageUri: string;
  sizeBytes: number;
  deduped: boolean; // an identical blob already existed for this run
}

export interface ArtifactStore {
  save(tx: SqlExecutor, a: SaveArtifact): Promise<SavedArtifact>;
  read(artifactId: string, tx: SqlExecutor): Promise<{ content: Buffer; mediaType: string }>;
}

export function createArtifactStore(root: string): ArtifactStore {
  return {
    async save(tx, a) {
      const bytes =
        typeof a.content === "string" ? Buffer.from(a.content, "utf8") : Buffer.from(a.content);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const dir = join(root, a.runId);
      const path = join(dir, sha256);
      const storageUri = `file://${path}`;

      await mkdir(dir, { recursive: true });
      await writeFile(path, bytes); // idempotent: same content, same name

      const inserted = await tx.execute(sql`
        INSERT INTO artifacts (id, run_id, task_id, attempt_id, type, name, media_type,
                               storage_uri, size_bytes, sha256, created_by, metadata)
        VALUES (${a.id}, ${a.runId}, ${a.taskId ?? null}, ${a.attemptId ?? null}, ${a.type},
                ${a.name}, ${a.mediaType ?? "text/markdown"}, ${storageUri}, ${bytes.length},
                ${sha256}, ${a.createdBy}, ${JSON.stringify(a.metadata ?? {})}::jsonb)
        ON CONFLICT (run_id, sha256) WHERE sha256 IS NOT NULL DO NOTHING
        RETURNING id`);
      if (inserted[0]) {
        return { id: a.id, sha256, storageUri, sizeBytes: bytes.length, deduped: false };
      }
      const existing = await tx.execute(sql`
        SELECT id, storage_uri, size_bytes FROM artifacts
        WHERE run_id = ${a.runId} AND sha256 = ${sha256}`);
      const row = existing[0];
      if (!row) throw new Error(`artifact dedup race: sha ${sha256} vanished`);
      return {
        id: row.id as string,
        sha256,
        storageUri: row.storage_uri as string,
        sizeBytes: row.size_bytes as number,
        deduped: true,
      };
    },

    async read(artifactId, tx) {
      const rows = await tx.execute(sql`
        SELECT storage_uri, media_type FROM artifacts WHERE id = ${artifactId}`);
      const row = rows[0];
      if (!row) throw new Error(`artifact ${artifactId} not found`);
      const uri = row.storage_uri as string;
      if (!uri.startsWith("file://")) throw new Error(`unsupported storage_uri: ${uri}`);
      return {
        content: Buffer.from(await readFile(uri.slice("file://".length))),
        mediaType: row.media_type as string,
      };
    },
  };
}
