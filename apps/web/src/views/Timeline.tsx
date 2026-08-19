// Kind-colored event timeline with SSE live tail (§24.3 kinds). History loads
// via the read API; new events stream in over the same reconnect-safe cursor
// the SSE endpoint exposes (decision D2).
import { useEffect, useRef, useState } from "react";
import { type EventRow, eventStreamUrl, useEvents } from "../api";

export function Timeline({ runId }: { runId: string }) {
  const { data: history } = useEvents(runId);
  const [liveEvents, setLiveEvents] = useState<EventRow[]>([]);
  const [streaming, setStreaming] = useState(false);
  const lastId = useRef<string | null>(null);

  const historyLast = history?.at(-1)?.id;
  useEffect(() => {
    if (historyLast === undefined) return;
    lastId.current ??= historyLast;
    const es = new EventSource(eventStreamUrl(runId, lastId.current));
    es.onopen = () => setStreaming(true);
    es.onerror = () => setStreaming(false);
    const onMessage = (e: MessageEvent) => {
      const row = JSON.parse(e.data as string) as EventRow;
      lastId.current = row.id;
      setLiveEvents((prev) => (prev.some((p) => p.id === row.id) ? prev : [...prev, row]));
    };
    // The api names each SSE event by its lab event type, so listen generically.
    const types = new Set<string>();
    const generic = (e: Event) => onMessage(e as MessageEvent);
    const origAdd = es.addEventListener.bind(es);
    // EventSource only fires named listeners; poll history covers rare unknown types.
    for (const t of [
      "RUN_CREATED",
      "RUN_PHASE_CHANGED",
      "RUN_COMPLETED",
      "RUN_FAILED",
      "RUN_CANCELLED",
      "TASK_READY",
      "TASK_BLOCKED",
      "TASK_CLAIMED",
      "TASK_CLAIM_EXPIRED",
      "TASK_RETRY",
      "TASK_FAILED",
      "ATTEMPT_SUCCEEDED",
      "ATTEMPT_FAILED",
      "ATTEMPT_ACCEPTED",
      "CANONICALIZATION_ENQUEUED",
      "BUDGET_WARNING",
    ]) {
      types.add(t);
      origAdd(t, generic);
    }
    return () => es.close();
  }, [runId, historyLast]);

  const seen = new Set<string>();
  const all = [...(history ?? []), ...liveEvents].filter((e) =>
    seen.has(e.id) ? false : (seen.add(e.id), true),
  );

  return (
    <div className="card">
      <div className="hd">
        Event timeline
        <span style={{ marginLeft: "auto" }}>
          <span className={`dot ${streaming ? "pulse" : "off"}`} />
          {streaming ? "live" : "polling"}
        </span>
      </div>
      <div className="bd">
        <ul className="tl">
          {all.map((e) => (
            <li key={e.id}>
              <span className={`k ${e.kind}`} />
              <span className="t">{e.createdAt.slice(11, 19)}</span>
              <span className="ev">
                <span className="ty">{e.type}</span>
                <span className="actor">{e.actor}</span>
                {Object.keys(e.payload).length > 0 && (
                  <div className="pl">{JSON.stringify(e.payload)}</div>
                )}
              </span>
            </li>
          ))}
          {all.length === 0 && <li className="faint">no events yet</li>}
        </ul>
      </div>
    </div>
  );
}
