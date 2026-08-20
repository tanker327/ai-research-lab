// Ticket 1.6 acceptance: events written through emitEvent (worker side) arrive
// over the api's SSE stream in id order; Last-Event-ID resumes after the
// cursor; a missed NOTIFY (row inserted without the doorbell) is recovered by
// the fallback poll — nothing is lost, only delayed.
import { emitEvent } from "@lab/core";
import { createArtifactStore, createDb, deleteRun, seedRun } from "@lab/db";
import { newId } from "@lab/schemas";
import { pino } from "pino";
import postgres from "postgres";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { createEventBus, type EventBus } from "./event-bus";

const url = process.env.DATABASE_URL ?? "postgres://lab:lab@localhost:5434/research_lab";
const { db, close } = createDb(url);
const raw = postgres(url);
const log = pino({ level: "silent" });

let runId: string;
let bus: EventBus;

beforeEach(async () => {
  runId = newId();
  await seedRun(db, runId);
  bus = createEventBus(url, log, { pollMs: 200 });
  // The LISTEN connection attaches asynchronously; give it a beat so the
  // notify path (not only the poll) is what the ordered tests exercise.
  await new Promise((r) => setTimeout(r, 150));
});

afterEach(async () => {
  await bus.stop();
  await deleteRun(db, runId);
});

afterAll(async () => {
  await close();
  await raw.end();
});

interface SseEvent {
  id: string;
  event: string;
  data: Record<string, unknown>;
}

// Collect n SSE events from a streaming response, then abort the request.
async function collect(
  path: string,
  n: number,
  {
    headers = {},
    timeoutMs = 5_000,
    frames = "named",
  }: {
    headers?: Record<string, string>;
    timeoutMs?: number;
    // Every event is written twice since 6.3 (named + default `message`
    // frame, D4). "named" keeps the historical assertions; "all" sees both.
    frames?: "named" | "all";
  } = {},
): Promise<SseEvent[]> {
  const app = createApp({ db, bus, log, artifacts: createArtifactStore("./data/artifacts-test") });
  const controller = new AbortController();
  const res = await app.request(path, { headers, signal: controller.signal });
  expect(res.status).toBe(200);
  const reader = res.body?.getReader();
  if (!reader) throw new Error("no body");
  const decoder = new TextDecoder();
  let buffer = "";
  const events: SseEvent[] = [];
  const deadline = Date.now() + timeoutMs;
  try {
    while (events.length < n) {
      if (Date.now() > deadline) throw new Error(`timeout: got ${events.length}/${n} events`);
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.indexOf("\n\n");
      while (sep !== -1 && events.length < n) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const field = (name: string) =>
          block
            .split("\n")
            .find((l) => l.startsWith(`${name}:`))
            ?.slice(name.length + 1)
            .trim();
        const data = field("data");
        if (data !== undefined && (frames === "all" || field("event") !== undefined)) {
          events.push({
            id: field("id") ?? "",
            event: field("event") ?? "",
            data: JSON.parse(data),
          });
        }
        sep = buffer.indexOf("\n\n");
      }
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => {});
  }
  return events;
}

const emit = (type: string) => emitEvent(db, { runId, type, kind: "info", actor: "test-worker" });

describe("GET /runs/:id/events/stream", () => {
  it("delivers worker-written events in id order over SSE", async () => {
    const pending = collect(`/runs/${runId}/events/stream`, 3);
    await emit("E1");
    await emit("E2");
    await emit("E3");
    const events = await pending;
    expect(events.map((e) => e.event)).toEqual(["E1", "E2", "E3"]);
    expect([...events.map((e) => e.id)].sort()).toEqual(events.map((e) => e.id)); // UUIDv7 order
    expect(events[0]?.data).toMatchObject({ type: "E1", actor: "test-worker", runId });
  });

  it("replays history to a late subscriber, then streams live events", async () => {
    await emit("OLD1");
    await emit("OLD2");
    const pending = collect(`/runs/${runId}/events/stream`, 3);
    await emit("LIVE1");
    const events = await pending;
    expect(events.map((e) => e.event)).toEqual(["OLD1", "OLD2", "LIVE1"]);
  });

  it("resumes after Last-Event-ID without duplicates", async () => {
    const firstId = await emitEvent(db, { runId, type: "A", kind: "info", actor: "t" });
    await emit("B");
    await emit("C");
    const events = await collect(`/runs/${runId}/events/stream`, 2, {
      headers: { "Last-Event-ID": firstId },
    });
    expect(events.map((e) => e.event)).toEqual(["B", "C"]);
  });

  it("duplicates every event as a default `message` frame (6.3, G5 fix)", async () => {
    const pending = collect(`/runs/${runId}/events/stream`, 2, { frames: "all" });
    await emit("ANY_NEW_TYPE"); // a type no client ever hardcoded
    const frames = await pending;
    expect(frames[0]?.event).toBe("ANY_NEW_TYPE");
    expect(frames[1]?.event).toBe(""); // the generic frame es.onmessage receives
    expect(frames[1]?.id).toBe(frames[0]?.id);
    expect(frames[1]?.data).toEqual(frames[0]?.data);
  });

  it("recovers a missed NOTIFY via the fallback poll", async () => {
    const pending = collect(`/runs/${runId}/events/stream`, 1, { timeoutMs: 4_000 });
    // Insert the row WITHOUT ringing the doorbell — a lost notification.
    await raw`INSERT INTO events (id, run_id, type, kind, actor)
              VALUES (${newId()}, ${runId}, 'SILENT', 'info', 't')`;
    const events = await pending;
    expect(events.map((e) => e.event)).toEqual(["SILENT"]);
  });
});
