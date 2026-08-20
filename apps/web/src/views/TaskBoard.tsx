// Staged task board + inspector drawer + trace viewer (ticket 6.1, D1/D2).
// Columns are PLAN STAGES, never a force-directed graph and never status
// groups — stages are the semantics of staged planning (ADR-019); status is a
// badge on the card. Clicking a card opens the inspector drawer (attempts,
// superseded dimmed — liveness made visible); "View full trace" opens the
// modal viewer over the same TraceBlocks the transcript renders. Esc closes
// the viewer first, then the drawer (§24.6).
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { StatusBadge } from "@/components/status-badge";
import { TraceBlocks } from "@/components/trace-blocks";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { type AttemptRow, type TaskRow, useAttempts, useTasks, useTrace } from "../api";

const mono = "font-mono text-[0.72rem]";

function TraceViewer({
  runId,
  attemptId,
  onClose,
}: {
  runId: string;
  attemptId: string;
  onClose: () => void;
}) {
  const { data: trace } = useTrace(runId, attemptId);
  return (
    // Backdrop click-to-close mirrors Esc; the keyboard path is the global
    // Esc handler in TaskBoard, so no key handler belongs on the backdrop.
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismiss surface
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc (global) is the keyboard equivalent
    <div
      className="fixed inset-0 z-[80] grid place-items-center bg-foreground/30 p-6"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="flex max-h-[86vh] w-[min(760px,94vw)] flex-col rounded-lg border bg-card shadow-xl">
        <div className="flex items-center gap-2.5 border-b px-5 py-3.5">
          {trace ? (
            <>
              <span className={cn(mono, "text-muted-foreground")}>{trace.attempt.taskType}</span>
              <span className="text-[0.9rem]">{trace.attempt.taskTitle}</span>
              <span className={cn(mono, "text-muted-foreground")}>
                {trace.attempt.agentName}/{trace.attempt.agentVersion} · attempt{" "}
                {trace.attempt.attemptNumber}
              </span>
              <StatusBadge status={trace.attempt.status} />
            </>
          ) : (
            <span className="text-muted-foreground">loading trace…</span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="ml-auto cursor-pointer text-muted-foreground hover:text-foreground"
            aria-label="close trace"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">
          {trace && <TraceBlocks attemptId={trace.attempt.id} blocks={trace.blocks} />}
        </div>
      </div>
    </div>
  );
}

function DrawerAttempt({ a, onTrace }: { a: AttemptRow; onTrace: (attemptId: string) => void }) {
  const dimmed = a.status === "SUPERSEDED" || a.status === "REJECTED";
  return (
    <div className={cn("rounded-md border px-3 py-2.5 text-[0.8rem]", dimmed && "opacity-55")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn(mono, "text-muted-foreground")}>#{a.attemptNumber}</span>
        <span className={mono}>{a.agentName}</span>
        <StatusBadge status={a.status} />
        {a.modelTier && (
          <Badge variant={a.modelTier === "frontier" ? "frontier" : "secondary"}>
            {a.modelTier}
          </Badge>
        )}
      </div>
      {a.error && (
        <div className={cn(mono, "mt-1 text-fail")}>
          {a.error.category}: {a.error.message?.slice(0, 140)}
        </div>
      )}
      <button
        type="button"
        onClick={() => onTrace(a.id)}
        className={cn(mono, "mt-1.5 cursor-pointer text-live underline-offset-2 hover:underline")}
      >
        View full trace →
      </button>
    </div>
  );
}

function Drawer({
  runId,
  task,
  onClose,
  onTrace,
}: {
  runId: string;
  task: TaskRow;
  onClose: () => void;
  onTrace: (attemptId: string) => void;
}) {
  const { data: attempts } = useAttempts(runId);
  const taskAttempts = (attempts ?? [])
    .filter((a) => a.taskId === task.id)
    .sort((x, y) => y.attemptNumber - x.attemptNumber);
  return (
    <aside className="fixed inset-y-0 right-0 z-[70] flex w-[min(440px,92vw)] flex-col border-l bg-card shadow-[-12px_0_32px_rgba(23,36,31,0.08)]">
      <div className="flex items-start gap-2.5 border-b px-5 py-4">
        <div>
          <div className={cn(mono, "uppercase tracking-[0.06em] text-muted-foreground")}>
            {task.type} · stage {task.planStage}
          </div>
          <h3 className="mt-0.5 text-[0.95rem] font-semibold leading-tight">{task.title}</h3>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <StatusBadge status={task.status} />
            {task.strategy && <Badge variant="secondary">{task.strategy}</Badge>}
            {task.modelTier && (
              <Badge variant={task.modelTier === "frontier" ? "frontier" : "run"}>
                tier: {task.modelTier}
              </Badge>
            )}
            <span className={cn(mono, "text-muted-foreground")}>
              attempts {task.attemptCount}/{task.maxAttempts}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto cursor-pointer text-muted-foreground hover:text-foreground"
          aria-label="close inspector"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="grid flex-1 content-start gap-2 overflow-y-auto px-5 py-4">
        {taskAttempts.map((a) => (
          <DrawerAttempt key={a.id} a={a} onTrace={onTrace} />
        ))}
        {taskAttempts.length === 0 && (
          <div className="text-[0.8rem] text-muted-foreground">no attempts yet</div>
        )}
      </div>
    </aside>
  );
}

export function TaskBoard({ runId }: { runId: string }) {
  const { data: tasks } = useTasks(runId);
  const [selected, setSelected] = useState<string | null>(null);
  const [traceOf, setTraceOf] = useState<string | null>(null);

  // Esc closes the viewer first, then the drawer (§24.6 floor).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (traceOf) setTraceOf(null);
      else setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [traceOf]);

  const stages = [...new Set((tasks ?? []).map((t) => t.planStage))].sort((a, b) => a - b);
  const selectedTask = tasks?.find((t) => t.id === selected) ?? null;

  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] items-start gap-3.5">
        {stages.map((stage) => {
          const stageTasks = (tasks ?? [])
            .filter((t) => t.planStage === stage)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          return (
            <div key={stage}>
              <div className="flex justify-between px-0.5 pb-2 pt-1 font-mono text-[0.64rem] uppercase tracking-[0.08em] text-muted-foreground">
                <span>stage {stage}</span>
                <span>{stageTasks.length}</span>
              </div>
              {stageTasks.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setSelected(t.id)}
                  className={cn(
                    "mb-2 w-full cursor-pointer rounded-md border bg-card px-3 py-2.5 text-left text-[0.8rem] hover:border-live",
                    selected === t.id && "border-live",
                    (t.status === "CANCELLED" || t.status === "BLOCKED") && "opacity-55",
                  )}
                >
                  <div className="mb-0.5 flex items-center gap-1.5">
                    <span className="font-mono text-[0.62rem] uppercase tracking-[0.06em] text-muted-foreground">
                      {t.type}
                    </span>
                    <span className="ml-auto">
                      <StatusBadge status={t.status} />
                    </span>
                  </div>
                  <div>{t.title}</div>
                  <div className="mt-1.5 font-mono text-[0.66rem] text-muted-foreground">
                    attempts {t.attemptCount}/{t.maxAttempts}
                    {t.claimedBy ? ` · ${t.claimedBy}` : ""}
                    {t.modelTier ? ` · →${t.modelTier}` : ""}
                  </div>
                </button>
              ))}
            </div>
          );
        })}
        {stages.length === 0 && <div className="text-muted-foreground">no tasks yet</div>}
      </div>
      {selectedTask && (
        <Drawer
          runId={runId}
          task={selectedTask}
          onClose={() => setSelected(null)}
          onTrace={(id) => setTraceOf(id)}
        />
      )}
      {traceOf && (
        <TraceViewer runId={runId} attemptId={traceOf} onClose={() => setTraceOf(null)} />
      )}
    </>
  );
}
