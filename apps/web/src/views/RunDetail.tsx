import { navigate } from "../App";
import { cancelRun, useRun, useTasks } from "../api";
import { AttemptsView } from "./Attempts";
import { Placeholder } from "./Placeholder";
import { statusChip } from "./Runs";
import { Timeline } from "./Timeline";

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
  { key: "evidence", label: "Evidence", badge: "P3" },
  { key: "report", label: "Report", badge: "P5" },
  { key: "transcript", label: "Transcript", badge: "P5" },
];

export function RunDetail({ runId, tab }: { runId: string; tab: string }) {
  const { data: run } = useRun(runId);
  const { data: tasks } = useTasks(runId);
  const terminal = run && ["COMPLETED", "FAILED", "CANCELLED"].includes(run.status);

  return (
    <>
      <div className="topbar">
        <button type="button" className="mono faint" onClick={() => navigate("/runs")}>
          ← runs
        </button>
        <h2>{run?.title ?? run?.userRequest ?? runId}</h2>
        {run && <span className={statusChip(run.status)}>{run.status}</span>}
        {run && !terminal && (
          <button
            type="button"
            className="btn danger"
            style={{ marginLeft: "auto" }}
            onClick={() => cancelRun(runId)}
          >
            Cancel run
          </button>
        )}
      </div>
      <div className="tabs">
        {TABS.map((t) => (
          <button
            type="button"
            key={t.key}
            className={`tab ${tab === t.key ? "on" : ""}`}
            onClick={() => navigate(`/run/${runId}/${t.key}`)}
          >
            {t.label}
            {t.badge && <span className="badge">{t.badge}</span>}
          </button>
        ))}
      </div>
      <div className="content">
        {tab === "overview" && run && (
          <>
            <div className="card">
              <div className="hd">Run phase</div>
              <div className="bd">
                <div className="rail">
                  {PHASES.map((p, i) => {
                    const idx = PHASES.indexOf(run.status);
                    const isTerm = ["FAILED", "CANCELLED"].includes(run.status);
                    const cls = p === run.status ? "ph now" : !isTerm && idx > i ? "ph done" : "ph";
                    return (
                      <span key={p} style={{ display: "contents" }}>
                        {i > 0 && <span className="arrow">→</span>}
                        <span
                          className={
                            p === "COMPLETED" && run.status === "COMPLETED" ? "ph done" : cls
                          }
                        >
                          {p.toLowerCase()}
                        </span>
                      </span>
                    );
                  })}
                  {["FAILED", "CANCELLED"].includes(run.status) && (
                    <>
                      <span className="arrow">→</span>
                      <span
                        className="ph"
                        style={{ background: "var(--fail-soft)", color: "var(--fail)" }}
                      >
                        {run.status.toLowerCase()}
                      </span>
                    </>
                  )}
                </div>
              </div>
            </div>
            <div className="card">
              <div className="hd">Tasks</div>
              <div className="bd rail">
                {TASK_COLUMNS.map((s) => {
                  const n = tasks?.filter((t) => t.status === s).length ?? 0;
                  return n > 0 ? (
                    <span key={s} className={statusChip(s)}>
                      {s.toLowerCase()} · {n}
                    </span>
                  ) : null;
                })}
                {(tasks?.length ?? 0) === 0 && <span className="faint">no tasks</span>}
              </div>
            </div>
            <div className="card">
              <div className="hd">Request</div>
              <div className="bd soft">{run.userRequest}</div>
            </div>
          </>
        )}

        {tab === "tasks" && (
          <div className="board">
            {TASK_COLUMNS.filter((s) => tasks?.some((t) => t.status === s)).map((s) => (
              <div className="col" key={s}>
                <div className="colhd">
                  <span>{s}</span>
                  <span>{tasks?.filter((t) => t.status === s).length}</span>
                </div>
                {tasks
                  ?.filter((t) => t.status === s)
                  .map((t) => (
                    <div className="taskcard" key={t.id}>
                      <div className="ty">{t.type}</div>
                      <div>{t.title}</div>
                      <div className="meta">
                        attempts {t.attemptCount}/{t.maxAttempts}
                        {t.claimedBy ? ` · ${t.claimedBy}` : ""}
                      </div>
                    </div>
                  ))}
              </div>
            ))}
          </div>
        )}

        {tab === "timeline" && <Timeline runId={runId} />}

        {tab === "attempts" && <AttemptsView runId={runId} />}

        {tab === "evidence" && (
          <Placeholder
            title="Evidence & claims browser"
            phase="Phase 3"
            note="live_evidence / canonical claims land with the Researcher + Extractor pipeline. The liveness machinery already runs underneath — superseded attempts' rows are already going dark."
          />
        )}
        {tab === "report" && (
          <Placeholder
            title="Report with citation chips"
            phase="Phase 5"
            note="Synthesizer output with sentence→claim citation map (§24.4)."
          />
        )}
        {tab === "transcript" && (
          <Placeholder
            title="Transcript reading mode"
            phase="Phase 5"
            note="Chronological run narrative assembled from the trace read model (§24.2)."
          />
        )}
      </div>
    </>
  );
}
