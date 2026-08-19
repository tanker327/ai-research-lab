// Console v0 shell — a subset of the normative mockup (ADR-019, §24.6),
// pulled forward so every phase's capabilities land visibly. Views over real
// Phase-1 data: runs, new, overview, tasks, timeline (SSE live tail).
// Evidence / report / transcript are placeholders until Phases 3–5.
import { Database, FileText, FlaskConical, List } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
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

function NavButton({
  on,
  disabled,
  title,
  onClick,
  children,
}: {
  on?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 border-l-2 border-transparent px-4.5 py-1.5 text-left text-[0.86rem] text-secondary-foreground hover:bg-muted hover:text-foreground disabled:cursor-default disabled:text-muted-foreground disabled:hover:bg-transparent",
        on && "border-live bg-muted font-semibold text-foreground",
      )}
    >
      {children}
    </button>
  );
}

export function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <div className="grid min-h-screen grid-cols-[216px_1fr]">
      <nav className="sticky top-0 flex h-screen flex-col gap-1 border-r bg-card py-4">
        <div className="mb-2.5 border-b px-4.5 pb-4 pt-0.5">
          <h1 className="font-serif text-[1.25rem] tracking-[0.01em]">Research Lab</h1>
          <div className="mt-0.5 font-mono text-[0.66rem] uppercase tracking-[0.08em] text-muted-foreground">
            run console · v0
          </div>
        </div>
        <div className="px-4.5 pb-1 pt-3 font-mono text-[0.62rem] uppercase tracking-[0.1em] text-muted-foreground">
          Runs
        </div>
        <NavButton on={route.view === "runs"} onClick={() => navigate("/runs")}>
          <List className="size-3.5" /> All runs
        </NavButton>
        <NavButton on={route.view === "new"} onClick={() => navigate("/new")}>
          <FlaskConical className="size-3.5" /> New research
        </NavButton>
        <div className="px-4.5 pb-1 pt-3 font-mono text-[0.62rem] uppercase tracking-[0.1em] text-muted-foreground">
          Coming online
        </div>
        <NavButton disabled title="Phase 3">
          <Database className="size-3.5" /> Evidence · P3
        </NavButton>
        <NavButton disabled title="Phase 5">
          <FileText className="size-3.5" /> Reports · P5
        </NavButton>
        <div className="mt-auto border-t px-4.5 py-3 font-mono text-[0.64rem] leading-[1.7] text-muted-foreground">
          <div>
            <span className="mr-1.5 inline-block size-[7px] animate-pulse rounded-full bg-live align-[1px]" />
            api :8787
          </div>
          <div>phase 2 gateway · agents at P3</div>
        </div>
      </nav>
      <main className="min-w-0 pb-15">
        {route.view === "runs" && <RunsView />}
        {route.view === "new" && <NewRunView />}
        {route.view === "run" && route.runId && (
          <RunDetail runId={route.runId} tab={route.tab ?? "overview"} />
        )}
      </main>
    </div>
  );
}
