// Kind-colored event timeline with SSE live tail (§24.3 kinds). History loads
// via the read API; new events stream in over the same reconnect-safe cursor
// the SSE endpoint exposes (decision D2).
import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { type EventRow, eventStreamUrl, useEvents } from "../api";

const KIND_DOT: Record<string, string> = {
  info: "bg-input",
  accept: "bg-live",
  gate: "bg-frontier",
  warn: "bg-run",
  fail: "bg-fail",
};

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
    // 6.3 (bug G5): the api duplicates every event as a default `message`
    // frame precisely so this client never hardcodes event-type names again —
    // a hardcoded list silently froze the timeline for every P4/P5 type.
    es.onmessage = (e: MessageEvent) => {
      const row = JSON.parse(e.data as string) as EventRow;
      lastId.current = row.id;
      setLiveEvents((prev) => (prev.some((p) => p.id === row.id) ? prev : [...prev, row]));
    };
    return () => es.close();
  }, [runId, historyLast]);

  const seen = new Set<string>();
  const all = [...(history ?? []), ...liveEvents].filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });

  return (
    <Card>
      <CardHeader>
        Event timeline
        <span className="ml-auto flex items-center gap-1.5">
          <span
            className={cn(
              "inline-block size-[7px] rounded-full",
              streaming ? "animate-pulse bg-live" : "bg-muted-foreground",
            )}
          />
          {streaming ? "live" : "polling"}
        </span>
      </CardHeader>
      <CardContent>
        <ul>
          {all.map((e) => (
            <li
              key={e.id}
              className="grid grid-cols-[14px_150px_1fr] items-baseline gap-3 border-b py-1.5 text-[0.8rem] last:border-b-0"
            >
              <span
                className={cn("size-2 self-center rounded-full", KIND_DOT[e.kind] ?? "bg-input")}
              />
              <span className="font-mono text-[0.68rem] text-muted-foreground">
                {e.createdAt.slice(11, 19)}
              </span>
              <span>
                <span className="font-mono text-[0.74rem] font-medium">{e.type}</span>
                <span className="ml-2 text-[0.72rem] text-muted-foreground">{e.actor}</span>
                {Object.keys(e.payload).length > 0 && (
                  <div className="mt-0.5 break-words font-mono text-[0.68rem] text-secondary-foreground">
                    {JSON.stringify(e.payload)}
                  </div>
                )}
              </span>
            </li>
          ))}
          {all.length === 0 && <li className="text-muted-foreground">no events yet</li>}
        </ul>
      </CardContent>
    </Card>
  );
}
