import { useState } from "react";
import { navigate } from "../App";
import { createRun } from "../api";

// Phase 1: the engine takes an explicit task list (the Planner arrives in
// Phase 3 and replaces this). The demo chain exercises waves + a side-effect
// write so the run is interesting to watch.
function demoTasks() {
  const a = crypto.randomUUID();
  const b = crypto.randomUUID();
  return [
    {
      id: a,
      type: "research",
      title: "wave 1 — gather evidence",
      input: { fake: { behavior: "side_effect", excerpt: "console demo evidence" } },
    },
    {
      id: b,
      type: "extract",
      title: "wave 2 — extract",
      dependsOn: [a],
      input: { fake: { behavior: "sleep", ms: 400 } },
    },
    {
      type: "analyze",
      title: "wave 3 — analyze",
      dependsOn: [b],
      input: { fake: { behavior: "sleep", ms: 200 } },
    },
    { type: "research", title: "independent", input: { fake: { behavior: "sleep", ms: 300 } } },
  ];
}

export function NewRunView() {
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const { id } = await createRun({
        title: request.slice(0, 60) || "console run",
        userRequest: request || "console demo run",
        tasks: demoTasks(),
      });
      navigate(`/run/${id}`);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="topbar">
        <h2>New research</h2>
      </div>
      <div className="content">
        <div className="card">
          <div className="hd">Research request</div>
          <div className="bd" style={{ display: "grid", gap: 12 }}>
            <textarea
              rows={3}
              placeholder="What should the lab research? (free text — Phase 1 runs a fake demo task chain; the Planner turns this into a real plan in Phase 3)"
              value={request}
              onChange={(e) => setRequest(e.target.value)}
            />
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <button type="button" className="btn primary" onClick={submit} disabled={busy}>
                {busy ? "Starting…" : "Start run (demo task chain)"}
              </button>
              <span className="mono faint">
                seeds 4 fake tasks · 3 dependency waves · Planner arrives P3
              </span>
            </div>
            {err && <div style={{ color: "var(--fail)" }}>{err}</div>}
          </div>
        </div>
      </div>
    </>
  );
}
