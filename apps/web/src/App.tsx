// Console v0 shell — a subset of the normative mockup (ADR-019, §24.6),
// pulled forward so every phase's capabilities land visibly. Views over real
// Phase-1 data: runs, new, overview, tasks, timeline (SSE live tail).
// Evidence / report / transcript are placeholders until Phases 3–5.
import { useEffect, useState } from "react";
import { NewRunView } from "./views/NewRun";
import { RunDetail } from "./views/RunDetail";
import { RunsView } from "./views/Runs";

// Hash mini-router: #/runs · #/new · #/run/<id>/<tab>
export interface Route {
  view: "runs" | "new" | "run";
  runId?: string;
  tab?: string;
}

function parseHash(): Route {
  const h = window.location.hash.replace(/^#\/?/, "");
  const [a, b, c] = h.split("/");
  if (a === "run" && b) return { view: "run", runId: b, tab: c ?? "overview" };
  if (a === "new") return { view: "new" };
  return { view: "runs" };
}

export function navigate(to: string): void {
  window.location.hash = to;
}

export function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <div className="shell">
      <nav className="side">
        <div className="brand">
          <h1>Research Lab</h1>
          <div className="sub">run console · v0</div>
        </div>
        <div className="navsec">Runs</div>
        <button
          type="button"
          className={`navbtn ${route.view === "runs" ? "on" : ""}`}
          onClick={() => navigate("/runs")}
        >
          All runs
        </button>
        <button
          type="button"
          className={`navbtn ${route.view === "new" ? "on" : ""}`}
          onClick={() => navigate("/new")}
        >
          New research
        </button>
        <div className="navsec">Coming online</div>
        <button type="button" className="navbtn" disabled title="Phase 3">
          Evidence · P3
        </button>
        <button type="button" className="navbtn" disabled title="Phase 5">
          Reports · P5
        </button>
        <div className="side-foot">
          <div>
            <span className="dot pulse" />
            api :8787
          </div>
          <div>phase 1 engine · no agents yet</div>
        </div>
      </nav>
      <main className="main">
        {route.view === "runs" && <RunsView />}
        {route.view === "new" && <NewRunView />}
        {route.view === "run" && route.runId && (
          <RunDetail runId={route.runId} tab={route.tab ?? "overview"} />
        )}
      </main>
    </div>
  );
}
