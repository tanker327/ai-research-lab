// Transcript reading mode (ticket 5.4, §24.2/§24.5): the run's full story in
// staged order — every attempt's trace as an ordered block sequence, one plan
// stage per page. Superseded/rejected attempts render dimmed but PRESENT: the
// transcript exists to show what actually happened, not just what survived.
// Block rendering is shared with the inspector's trace viewer (6.1, D2).
import { useState } from "react";
import { StatusBadge } from "@/components/status-badge";
import { TraceBlocks } from "@/components/trace-blocks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { type TraceDto, useTranscript } from "../api";

const mono = "font-mono text-[0.72rem]";

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
      <CardContent>
        <TraceBlocks attemptId={a.id} blocks={trace.blocks} />
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
