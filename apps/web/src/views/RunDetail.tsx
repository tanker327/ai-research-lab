import { ArrowLeft } from "lucide-react";
import { Topbar } from "@/components/layout";
import { StatusBadge, statusVariant } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { navigate } from "../App";
import { cancelRun, useCheckpoints, useRun, useTasks } from "../api";
import { AttemptsView } from "./Attempts";
import { ClaimsView } from "./Claims";
import { ReportView } from "./Report";
import { TaskBoard } from "./TaskBoard";
import { Timeline } from "./Timeline";
import { TranscriptView } from "./Transcript";
import { VerdictsView } from "./Verdicts";

const PHASES = [
  "CREATED",
  "PLANNING",
  "RESEARCHING",
  "ANALYZING",
  "EVALUATING",
  "SYNTHESIZING",
  "COMPLETED",
];
const TASK_COLUMNS = [
  "CREATED",
  "READY",
  "RUNNING",
  "EVALUATING",
  "DONE",
  "FAILED",
  "BLOCKED",
  "CANCELLED",
];
const TABS = [
  { key: "overview", label: "Overview" },
  { key: "tasks", label: "Tasks" },
  { key: "timeline", label: "Timeline" },
  { key: "attempts", label: "Attempts" },
  { key: "evidence", label: "Evidence" },
  { key: "verdict", label: "Verdict" },
  { key: "report", label: "Report" },
  { key: "transcript", label: "Transcript" },
];

// Phase-rail pill (mockup .rail .ph) — done/now/pending/terminal states.
function PhasePill({
  state,
  children,
}: {
  state: "done" | "now" | "pending" | "terminal";
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "rounded-full border px-2.5 py-1 font-mono text-[0.68rem] text-muted-foreground",
        state === "done" && "border-transparent bg-live-soft text-live",
        state === "now" && "border-transparent bg-run-soft font-semibold text-run",
        state === "terminal" && "border-transparent bg-fail-soft text-fail",
      )}
    >
      {children}
    </span>
  );
}

export function RunDetail({ runId, tab }: { runId: string; tab: string }) {
  const { data: run } = useRun(runId);
  const { data: tasks } = useTasks(runId);
  const { data: checkpoints } = useCheckpoints(runId);
  const terminal = run && ["COMPLETED", "FAILED", "CANCELLED"].includes(run.status);
  const pendingCheckpoints = checkpoints?.filter((cp) => cp.status === "pending") ?? [];

  return (
    <>
      <Topbar>
        <Button
          variant="ghost"
          size="sm"
          className="font-mono text-[0.76rem] text-muted-foreground"
          onClick={() => navigate("/runs")}
        >
          <ArrowLeft className="size-3.5" /> runs
        </Button>
        <h2 className="font-serif text-[1.15rem]">{run?.title ?? run?.userRequest ?? runId}</h2>
        {run && <StatusBadge status={run.status} />}
        {run && !terminal && (
          <Button
            variant="destructive"
            size="sm"
            className="ml-auto"
            onClick={() => cancelRun(runId)}
          >
            Cancel run
          </Button>
        )}
      </Topbar>
      <Tabs value={tab} onValueChange={(t) => navigate(`/run/${runId}/${t}`)}>
        <TabsList>
          {TABS.map((t) => (
            <TabsTrigger key={t.key} value={t.key}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div className="grid gap-4.5 px-7 py-6">
        {run?.status === "WAITING_HUMAN" && pendingCheckpoints.length > 0 && (
          <Card className="border-fail">
            <CardHeader className="text-fail">Waiting on a human decision</CardHeader>
            <CardContent className="grid gap-2 text-[0.82rem]">
              {pendingCheckpoints.map((cp) => (
                <div key={cp.id}>
                  <span className="mr-2 font-mono text-[0.68rem] uppercase tracking-[0.06em] text-muted-foreground">
                    {cp.reason}
                  </span>
                  {cp.question}
                </div>
              ))}
              <div className="font-mono text-[0.68rem] text-muted-foreground">
                Checkpoint resolution UI lands in a later ticket — resolve via the database for now.
              </div>
            </CardContent>
          </Card>
        )}
        {tab === "overview" && run && (
          <>
            <Card>
              <CardHeader>Run phase</CardHeader>
              <CardContent>
                <div className="flex flex-wrap items-center gap-1.5">
                  {PHASES.map((p, i) => {
                    const idx = PHASES.indexOf(run.status);
                    const isTerm = ["FAILED", "CANCELLED"].includes(run.status);
                    const state =
                      p === run.status
                        ? p === "COMPLETED"
                          ? "done"
                          : "now"
                        : !isTerm && idx > i
                          ? "done"
                          : "pending";
                    return (
                      <span key={p} className="contents">
                        {i > 0 && <span className="text-[0.7rem] text-muted-foreground">→</span>}
                        <PhasePill state={state}>{p.toLowerCase()}</PhasePill>
                      </span>
                    );
                  })}
                  {["FAILED", "CANCELLED"].includes(run.status) && (
                    <>
                      <span className="text-[0.7rem] text-muted-foreground">→</span>
                      <PhasePill state="terminal">{run.status.toLowerCase()}</PhasePill>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>Tasks</CardHeader>
              <CardContent className="flex flex-wrap items-center gap-1.5">
                {TASK_COLUMNS.map((s) => {
                  const n = tasks?.filter((t) => t.status === s).length ?? 0;
                  return n > 0 ? (
                    <Badge key={s} variant={statusVariant(s)}>
                      {s.toLowerCase()} · {n}
                    </Badge>
                  ) : null;
                })}
                {(tasks?.length ?? 0) === 0 && (
                  <span className="text-muted-foreground">no tasks</span>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>Request</CardHeader>
              <CardContent className="text-secondary-foreground">{run.userRequest}</CardContent>
            </Card>
          </>
        )}

        {tab === "tasks" && <TaskBoard runId={runId} />}

        {tab === "timeline" && <Timeline runId={runId} />}

        {tab === "attempts" && <AttemptsView runId={runId} />}

        {tab === "evidence" && <ClaimsView runId={runId} />}
        {tab === "verdict" && <VerdictsView runId={runId} />}
        {tab === "report" && <ReportView runId={runId} />}
        {tab === "transcript" && <TranscriptView runId={runId} />}
      </div>
    </>
  );
}
