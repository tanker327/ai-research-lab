// Transcript reading mode (ticket 5.4, §24.2/§24.5): the run's full story in
// staged order — every attempt's trace as an ordered block sequence, one plan
// stage per page. Superseded/rejected attempts render dimmed but PRESENT: the
// transcript exists to show what actually happened, not just what survived.
// Reasoning artifacts appear as collapsed refs (display-only, ADR-018).
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { type TraceBlockDto, type TraceDto, useTranscript } from "../api";

const mono = "font-mono text-[0.72rem]";

function Json({ value }: { value: unknown }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-md bg-muted/40 px-3 py-2 font-mono text-[0.68rem] leading-relaxed">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function Collapsed({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(mono, "flex cursor-pointer items-center gap-1.5 text-muted-foreground")}
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        {label}
      </button>
      {open && <div className="mt-1.5">{children}</div>}
    </div>
  );
}

function Block({ block }: { block: TraceBlockDto }) {
  switch (block.kind) {
    case "context_in":
      return (
        <Collapsed label="context in — the verbatim Context Builder product (R12)">
          <Json value={block.input} />
        </Collapsed>
      );
    case "reasoning":
      return (
        <div className={cn(mono, "text-muted-foreground")}>
          reasoning · {block.artifacts.map((a) => a.name).join(", ")}
          <span className="ml-1.5 opacity-70">(display-only — never fed to agents, ADR-018)</span>
        </div>
      );
    case "tool_call":
      return (
        <div className="flex flex-wrap items-baseline gap-2 text-[0.78rem]">
          <span className={cn(mono, "text-muted-foreground")}>#{block.call.seq}</span>
          <span className={mono}>{block.call.toolName}</span>
          <span className={block.call.error ? "text-fail" : "text-secondary-foreground"}>
            {block.call.error
              ? (block.call.error.message ?? "failed")
              : (block.call.responseSnippet?.slice(0, 140) ?? "ok")}
          </span>
          {block.call.latencyMs !== null && (
            <span className={cn(mono, "text-muted-foreground")}>{block.call.latencyMs}ms</span>
          )}
        </div>
      );
    case "output":
      return (
        <div className="grid gap-1.5">
          {block.error ? (
            <div className="rounded-md bg-fail-soft px-3 py-1.5 text-[0.78rem] text-fail">
              {String(block.error.category ?? "error")} — {String(block.error.message ?? "")}
            </div>
          ) : (
            <Collapsed label="output">
              <Json value={block.output} />
            </Collapsed>
          )}
          {block.artifacts.length > 0 && (
            <div className={cn(mono, "text-muted-foreground")}>
              artifacts · {block.artifacts.map((a) => `${a.name} (${a.type})`).join(", ")}
            </div>
          )}
        </div>
      );
    case "control":
      return (
        <div className="grid gap-1 border-l-2 border-border pl-3">
          {block.entries.map((e) => (
            <div
              key={`${e.source}-${e.type}-${e.createdAt}`}
              className="flex flex-wrap items-baseline gap-2 text-[0.74rem]"
            >
              <Badge
                variant={
                  e.kind === "fail" || e.decision === "REJECT"
                    ? "fail"
                    : e.kind === "accept"
                      ? "live"
                      : "secondary"
                }
              >
                {e.source}
              </Badge>
              <span className={mono}>{e.type}</span>
              {e.decision && <span className={cn(mono, "text-run")}>{e.decision}</span>}
              <span className="text-secondary-foreground">{e.detail.slice(0, 220)}</span>
            </div>
          ))}
        </div>
      );
  }
}

function TraceCard({ trace }: { trace: TraceDto }) {
  const a = trace.attempt;
  const dimmed = a.status === "SUPERSEDED" || a.status === "REJECTED";
  return (
    <Card className={cn(dimmed && "opacity-60")}>
      <CardHeader>
        <span className={cn(mono, "text-muted-foreground")}>{a.taskType}</span>
        <span className="normal-case tracking-normal text-foreground">{a.taskTitle}</span>
        <span className={cn(mono, "text-muted-foreground")}>
          {a.agentName}/{a.agentVersion} · attempt {a.attemptNumber}
        </span>
        <StatusBadge status={a.status} />
        {a.modelTier && (
          <Badge variant={a.modelTier === "frontier" ? "frontier" : "secondary"}>
            {a.modelTier}
          </Badge>
        )}
      </CardHeader>
      <CardContent className="grid gap-2.5">
        {trace.blocks.map((b) => (
          <Block key={`${a.id}-${b.kind}-${b.kind === "tool_call" ? b.call.id : "1"}`} block={b} />
        ))}
      </CardContent>
    </Card>
  );
}

export function TranscriptView({ runId }: { runId: string }) {
  const [stage, setStage] = useState<number | undefined>(undefined);
  const { data: transcript, isLoading } = useTranscript(runId, stage);

  if (isLoading) return <div className="text-muted-foreground">loading…</div>;
  if (!transcript) {
    return (
      <Card>
        <CardHeader>Transcript</CardHeader>
        <CardContent className="text-muted-foreground">no attempts recorded yet</CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4.5">
      {transcript.stages.length > 1 && (
        <div className="flex items-center gap-1.5">
          <span className={cn(mono, "text-muted-foreground")}>plan stage</span>
          {transcript.stages.map((s) => (
            <Button
              key={s}
              size="sm"
              variant={s === transcript.stage ? "default" : "outline"}
              className="font-mono text-[0.72rem]"
              onClick={() => setStage(s)}
            >
              {s}
            </Button>
          ))}
        </div>
      )}
      {transcript.traces.map((t) => (
        <TraceCard key={t.attempt.id} trace={t} />
      ))}
      {transcript.traces.length === 0 && (
        <Card>
          <CardContent className="text-muted-foreground">no attempts in this stage yet</CardContent>
        </Card>
      )}
    </div>
  );
}
