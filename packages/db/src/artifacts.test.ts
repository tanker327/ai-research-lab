// Ticket 2.4 acceptance: content-addressed round-trip, dedupe on identical
// content (idx_artifacts_dedup), distinct blobs per run.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId } from "@lab/schemas";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createArtifactStore } from "./artifacts";
import { createDb } from "./client";
import { deleteRun, seedRun } from "./fixtures";

const url = process.env.DATABASE_URL ?? "postgres://lab:lab@localhost:5434/research_lab";
const { db, close } = createDb(url);
const root = mkdtempSync(join(tmpdir(), "lab-artifacts-"));
const store = createArtifactStore(root);

let runId: string;
beforeEach(async () => {
  runId = newId();
  await seedRun(db, runId);
});
afterEach(async () => {
  await deleteRun(db, runId);
});
afterAll(async () => {
  await close();
});

const save = (content: string, id = newId()) =>
  store.save(db, {
    id,
    runId,
    type: "page_snapshot",
    name: "test",
    content,
    createdBy: "test",
  });

describe("artifact store", () => {
  it("round-trips content by id with sha256 addressing", async () => {
    const saved = await save("hello artifacts");
    expect(saved.deduped).toBe(false);
    expect(saved.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(saved.storageUri).toBe(`file://${join(root, runId, saved.sha256)}`);

    const back = await store.read(saved.id, db);
    expect(back.content.toString()).toBe("hello artifacts");
  });

  it("dedupes identical content within a run — same row, no duplicate", async () => {
    const first = await save("same bytes");
    const second = await save("same bytes"); // different requested id
    expect(second.deduped).toBe(true);
    expect(second.id).toBe(first.id);
  });

  it("different content gets different rows", async () => {
    const a = await save("aaa");
    const b = await save("bbb");
    expect(a.id).not.toBe(b.id);
    expect(a.sha256).not.toBe(b.sha256);
  });

  it("identical content in a DIFFERENT run is a separate artifact (dedup is per run)", async () => {
    const otherRun = newId();
    await seedRun(db, otherRun);
    try {
      const a = await save("shared page");
      const b = await store.save(db, {
        id: newId(),
        runId: otherRun,
        type: "page_snapshot",
        name: "test",
        content: "shared page",
        createdBy: "test",
      });
      expect(b.deduped).toBe(false);
      expect(b.id).not.toBe(a.id);
    } finally {
      await deleteRun(db, otherRun);
    }
  });
});
