// Plan Review screen (ticket 7.4, phase-7-plan D6): the run parked at its
// plan_review checkpoint. Spec displayed read-only (editing it = spec
// versioning, deferred D7); tasks editable in place (question/priority/tier),
// removable, addable; run-wide role→tier table; "Start research" approves the
// checkpoint, "Discard" stops the run. Every edit lands as an audited
// control-plane operation — this screen never mutates state directly.
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { navigate } from "../App";
import {
  addPlanTask,
  editPlanTask,
  removePlanTask,
  resolveCheckpoint,
  type TaskRow,
  updateRunRouting,
  useCheckpoints,
  useRun,
  useSpec,
  useTasks,
} from "../api";

const mono = "font-mono text-[0.72rem]";
const ROLES = [
  "planner",
  "researcher",
  "extractor",
  "analyst",
  "evaluator",
  "synthesizer",
] as const;
const TIERS = ["policy", "frontier", "strong_local", "fast_local"] as const;

function TaskEditor({
  runId,
  task,
  onError,
}: {
  runId: string;
  task: TaskRow;
  onError: (msg: string | null) => void;
}) {
  const [question, setQuestion] = useState(String(task.input.researchQuestion ?? ""));
  const [priority, setPriority] = useState(task.priority);
  const [tier, setTier] = useState(task.modelTier ?? "policy");
  const dirty =
    question !== String(task.input.researchQuestion ?? "") ||
    priority !== task.priority ||
    (task.modelTier ?? "policy") !== tier;

  const save = async () => {
    onError(null);
    try {
      await editPlanTask(runId, task.id, {
        ...(question !== String(task.input.researchQuestion ?? "")
          ? { researchQuestion: question }
          : {}),
        ...(priority !== task.priority ? { priority } : {}),
        ...((task.modelTier ?? "policy") !== tier
          ? { modelTier: tier === "policy" ? null : tier }
          : {}),
      });
    } catch (e) {
      onError(String(e));
    }
  };

  return (
    <div className="rounded-md border bg-card px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn(mono, "uppercase tracking-[0.06em] text-muted-foreground")}>
          {task.type}
        </span>
        <span className="text-[0.84rem]">{task.title}</span>
        <button
          type="button"
          onClick={async () => {
            onError(null);
            await removePlanTask(runId, task.id).catch((e) => onError(String(e)));
          }}
          className="ml-auto cursor-pointer text-muted-foreground hover:text-fail"
          aria-label="remove task"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
      {task.type === "research" && (
        <Textarea
          rows={2}
          className="mt-2 text-[0.8rem]"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2.5">
        <label className={cn(mono, "flex items-center gap-1.5 text-muted-foreground")}>
          priority
          <input
            type="number"
            min={0}
            max={100}
            value={priority}
            onChange={(e) => setPriority(Number(e.target.value))}
            className="w-16 rounded-md border bg-card px-1.5 py-1"
          />
        </label>
        <label className={cn(mono, "flex items-center gap-1.5 text-muted-foreground")}>
          tier
          <select
            value={tier}
            onChange={(e) => setTier(e.target.value)}
            className="rounded-md border bg-card px-1.5 py-1"
          >
            {TIERS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        {dirty && (
          <Button size="sm" onClick={save}>
            Save
          </Button>
        )}
      </div>
    </div>
  );
}

export function PlanReviewView({ runId }: { runId: string }) {
  const { data: run } = useRun(runId);
  const { data: spec } = useSpec(runId);
  const { data: tasks } = useTasks(runId);
  const { data: checkpoints } = useCheckpoints(runId);
  const [error, setError] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newQuestion, setNewQuestion] = useState("");
  const [busy, setBusy] = useState(false);

  const review = checkpoints?.find((cp) => cp.reason === "plan_review" && cp.status === "pending");
  const roleTiers = (run?.metadata.roleTiers as Record<string, string> | undefined) ?? {};
  const editable = (tasks ?? []).filter((t) => t.status === "CREATED" && t.type !== "plan");

  if (run && !review) {
    return (
      <Card>
        <CardHeader>Plan review</CardHeader>
        <CardContent className="text-muted-foreground">
          {run.metadata.reviewPlan === true && (tasks ?? []).every((t) => t.type === "plan")
            ? "the Planner is still working — this screen opens for editing the moment the stage-1 plan lands"
            : run.status === "WAITING_HUMAN"
              ? "this run is parked on a different checkpoint — see the Overview banner"
              : "this run is not waiting on a plan review — it already started"}
        </CardContent>
      </Card>
    );
  }

  const approve = async () => {
    if (!review) return;
    setBusy(true);
    setError(null);
    try {
      await resolveCheckpoint(runId, review.id, "approve", "plan approved from review screen");
      navigate(`/run/${runId}/overview`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (!review) return;
    setBusy(true);
    setError(null);
    try {
      await resolveCheckpoint(runId, review.id, "stop", "plan discarded from review screen");
      navigate(`/run/${runId}/overview`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4.5">
      <Card>
        <CardHeader>
          Specification
          {spec && <span className={cn(mono, "ml-2 text-muted-foreground")}>v{spec.version}</span>}
          <span className={cn(mono, "ml-auto text-muted-foreground")}>
            read-only — spec editing arrives with versioning (§13)
          </span>
        </CardHeader>
        <CardContent className="grid gap-1.5 text-[0.82rem]">
          {spec ? (
            <>
              <div>{spec.objective}</div>
              {spec.keyQuestions.length > 0 && (
                <div className="text-secondary-foreground">
                  {spec.keyQuestions.map((q) => (
                    <div key={q.slice(0, 60)}>· {q}</div>
                  ))}
                </div>
              )}
              {spec.successCriteria.length > 0 && (
                <div className={cn(mono, "text-muted-foreground")}>
                  success: {spec.successCriteria.join(" · ")}
                </div>
              )}
            </>
          ) : (
            <span className="text-muted-foreground">loading spec…</span>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          Planned tasks
          <span className={cn(mono, "ml-2 text-muted-foreground")}>{editable.length} editable</span>
        </CardHeader>
        <CardContent className="grid gap-2.5">
          {editable.map((t) => (
            <TaskEditor
              key={`${t.id}-${t.priority}-${t.modelTier}`}
              runId={runId}
              task={t}
              onError={setError}
            />
          ))}
          <div className="rounded-md border border-dashed px-3.5 py-3">
            <div className={cn(mono, "mb-1.5 uppercase tracking-[0.06em] text-muted-foreground")}>
              add research task
            </div>
            <input
              placeholder="title"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              className="mb-1.5 w-full rounded-md border bg-card px-2.5 py-1.5 text-[0.8rem]"
            />
            <Textarea
              rows={2}
              placeholder="research question (concrete — no placeholders)"
              value={newQuestion}
              onChange={(e) => setNewQuestion(e.target.value)}
            />
            <Button
              size="sm"
              className="mt-1.5"
              disabled={!newTitle.trim() || newQuestion.trim().length < 12}
              onClick={async () => {
                setError(null);
                try {
                  await addPlanTask(runId, { title: newTitle, researchQuestion: newQuestion });
                  setNewTitle("");
                  setNewQuestion("");
                } catch (e) {
                  setError(String(e));
                }
              }}
            >
              Add task
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>Model routing · per-agent tier</CardHeader>
        <CardContent className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-2.5">
          {ROLES.map((role) => (
            <label key={role} className="grid gap-1 text-[0.76rem]">
              <span className={cn(mono, "uppercase tracking-[0.06em] text-muted-foreground")}>
                {role}
              </span>
              <select
                value={roleTiers[role] ?? "policy"}
                onChange={async (e) => {
                  setError(null);
                  const next = { ...roleTiers };
                  if (e.target.value === "policy") delete next[role];
                  else next[role] = e.target.value;
                  await updateRunRouting(runId, next).catch((err) => setError(String(err)));
                }}
                className={cn(
                  "rounded-md border bg-card px-2 py-1.5 font-mono text-[0.74rem]",
                  roleTiers[role] && "border-run",
                )}
              >
                {TIERS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-2.5">
        <Button onClick={approve} disabled={busy || !review}>
          Start research
        </Button>
        <Button variant="destructive" onClick={discard} disabled={busy || !review}>
          Discard run
        </Button>
        <Badge variant="run">plan review — nothing runs until you approve</Badge>
      </div>
      {error && <div className="text-[0.8rem] text-fail">{error.slice(0, 300)}</div>}
    </div>
  );
}
