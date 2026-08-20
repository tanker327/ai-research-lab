// Overview metric grid + latest-verdict card (ticket 6.2, D3, §24.6): the
// mockup's six-card grid over the one-round-trip dashboard endpoint —
// cycle-guard headroom and the frontier-vs-local split are first-class.
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { navigate } from "../App";
import { useMetrics, useVerdicts } from "../api";

const mono = "font-mono";

function Metric({
  value,
  unit,
  line,
  detail,
}: {
  value: string;
  unit: string;
  line: string;
  detail: string;
}) {
  return (
    <div className="rounded-md border bg-card px-3.5 py-3">
      <div className={cn(mono, "text-[1.35rem]")}>
        {value}
        <span className="ml-1 text-[0.72rem] font-normal text-muted-foreground">{unit}</span>
      </div>
      <div className="mt-0.5 text-[0.7rem] text-secondary-foreground">{line}</div>
      <div className={cn(mono, "mt-1 text-[0.62rem] text-muted-foreground")}>{detail}</div>
    </div>
  );
}

function wallClock(seconds: number): string {
  if (seconds < 90) return `${seconds}`;
  return `${Math.round(seconds / 60)}`;
}

export function OverviewMetrics({ runId }: { runId: string }) {
  const { data: m } = useMetrics(runId);
  const { data: verdicts } = useVerdicts(runId);
  const latest = verdicts?.at(-1);

  if (!m) return null;
  const headroom = Math.max(0, m.maxEvalCycles - m.evalCycles);
  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3.5">
        <Metric
          value={String(m.tasksTotal)}
          unit="tasks"
          line={`${m.tasksDone} done · ${m.tasksFailed} failed/cancelled`}
          detail={`${m.tasksResearch} research · ${m.tasksControl} control`}
        />
        <Metric
          value={String(m.attemptsTotal)}
          unit="attempts"
          line={`${m.intelligenceRetries} intelligence retries`}
          detail={`${m.tierEscalations} tier escalation${m.tierEscalations === 1 ? "" : "s"}`}
        />
        <Metric
          value={String(m.liveEvidence)}
          unit="evidence"
          line={`${m.liveClaims} canonical claims`}
          detail={`${m.contestedClaims} contested`}
        />
        <Metric
          value={String(m.modelCalls)}
          unit="calls"
          line={`${m.frontierCalls} frontier · ${m.modelCalls - m.frontierCalls} local`}
          detail={
            m.frontierSpendUsd !== null
              ? `$${m.frontierSpendUsd.toFixed(2)} frontier spend`
              : "no frontier spend"
          }
        />
        <Metric
          value={wallClock(m.wallClockSeconds)}
          unit={m.wallClockSeconds < 90 ? "sec" : "min"}
          line="wall clock"
          detail={`${m.toolCalls} tool calls · ${Math.round(m.toolLatencyMs / 1000)}s scraping`}
        />
        <Metric
          value={`${m.evalCycles} / ${m.maxEvalCycles}`}
          unit=""
          line="evaluation cycles"
          detail={`cycle guard headroom: ${headroom}`}
        />
      </div>
      {latest && (
        <Card>
          <CardHeader>
            Latest verdict
            <Badge
              className="ml-2"
              variant={
                latest.decision === "ACCEPT"
                  ? "live"
                  : latest.decision === "STOP" || latest.decision === "ESCALATE"
                    ? "fail"
                    : "run"
              }
            >
              {latest.decision}
            </Badge>
            {latest.metadata.cycle !== undefined && (
              <span className={cn(mono, "text-[0.68rem] text-muted-foreground")}>
                cycle {latest.metadata.cycle}
              </span>
            )}
            <button
              type="button"
              onClick={() => navigate(`/run/${runId}/verdict`)}
              className={cn(
                mono,
                "ml-auto cursor-pointer text-[0.72rem] text-live underline-offset-2 hover:underline",
              )}
            >
              all verdicts →
            </button>
          </CardHeader>
          <CardContent className="grid gap-1.5 text-[0.82rem]">
            {latest.reasons.slice(0, 3).map((r) => (
              <div key={r.slice(0, 60)} className="text-secondary-foreground">
                {r}
              </div>
            ))}
            {(latest.metadata.acceptedUncertainties ?? []).length > 0 && (
              <div className="mt-1 rounded-md bg-run-soft px-3 py-1.5 text-[0.78rem]">
                <span className={cn(mono, "mr-1.5 text-[0.66rem] uppercase tracking-[0.06em]")}>
                  accepted uncertainties
                </span>
                {(latest.metadata.acceptedUncertainties ?? []).join(" · ")}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}
