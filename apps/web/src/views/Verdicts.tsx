// Evaluator verdicts + per-cycle coverage (ticket 4.6, §24.2/§24.5). One card
// per cycle: decision, issues by severity, requiredActions, accepted
// uncertainties, and the coverage the Evaluator actually saw (persisted
// verbatim on the evaluation row, R13) — the cycle-1 → cycle-2 delta is the
// story worth showing.
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { type CoverageDto, useCoverage, useVerdicts, type VerdictRow } from "../api";

const mono = "font-mono text-[0.72rem]";

const DECISION_VARIANT: Record<string, "live" | "run" | "fail" | "secondary"> = {
  ACCEPT: "live",
  RESEARCH_MORE: "run",
  REANALYZE: "run",
  REPLAN: "run",
  ESCALATE: "fail",
  STOP: "fail",
};

const SEVERITY_ORDER = ["critical", "high", "medium", "low"];

function CoverageStats({ c }: { c: CoverageDto }) {
  const stats: Array<[string, string | number]> = [
    ["evidence", c.evidenceCount],
    ["claims", c.claimCount],
    ["contested", c.contestedCount],
    ["publishers", c.distinctPublishers],
    ["origins", c.distinctOrigins],
    ["vendor ratio", `${Math.round(c.vendorRatio * 100)}%`],
  ];
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {stats.map(([label, value]) => (
        <span key={label} className={cn(mono, "text-muted-foreground")}>
          {label} <span className="font-semibold text-foreground">{value}</span>
        </span>
      ))}
    </div>
  );
}

function VerdictCard({ v }: { v: VerdictRow }) {
  const issues = [...(v.metadata.issues ?? [])].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center gap-2">
        <span className={cn(mono, "text-muted-foreground")}>cycle {v.metadata.cycle ?? "?"}</span>
        <Badge variant={DECISION_VARIANT[v.decision] ?? "secondary"}>{v.decision}</Badge>
        <span className={cn(mono, "ml-auto text-muted-foreground")}>
          {new Date(v.createdAt).toLocaleString()}
        </span>
      </CardHeader>
      <CardContent className="grid gap-3 text-[0.8rem]">
        <div>
          {v.reasons.map((r) => (
            <div key={r} className="text-secondary-foreground">
              — {r}
            </div>
          ))}
        </div>
        {issues.length > 0 && (
          <div className="grid gap-1">
            <div className={cn(mono, "uppercase tracking-[0.08em] text-muted-foreground")}>
              issues
            </div>
            {issues.map((i) => (
              <div key={i.description} className="flex items-start gap-2">
                <Badge
                  variant={
                    i.severity === "critical" || i.severity === "high" ? "fail" : "secondary"
                  }
                >
                  {i.severity}
                </Badge>
                <span className={cn(mono, "pt-0.5 text-muted-foreground")}>{i.category}</span>
                <span className="text-secondary-foreground">{i.description}</span>
              </div>
            ))}
          </div>
        )}
        {(v.metadata.requiredActions?.length ?? 0) > 0 && (
          <div className="grid gap-1">
            <div className={cn(mono, "uppercase tracking-[0.08em] text-muted-foreground")}>
              required actions → follow-up tasks
            </div>
            {v.metadata.requiredActions?.map((a) => (
              <div key={a.question} className="border-l-2 border-border py-0.5 pl-3">
                <div>{a.question}</div>
                <div className={cn(mono, "text-muted-foreground")}>{a.rationale}</div>
              </div>
            ))}
          </div>
        )}
        {(v.metadata.acceptedUncertainties?.length ?? 0) > 0 && (
          <div className="grid gap-1">
            <div className={cn(mono, "uppercase tracking-[0.08em] text-muted-foreground")}>
              accepted uncertainties (surfaced in the report)
            </div>
            {v.metadata.acceptedUncertainties?.map((u) => (
              <div key={u} className="text-secondary-foreground">
                ⚠ {u}
              </div>
            ))}
          </div>
        )}
        {v.metadata.coverage && (
          <div className="grid gap-1">
            <div className={cn(mono, "uppercase tracking-[0.08em] text-muted-foreground")}>
              coverage at judgment
            </div>
            <CoverageStats c={v.metadata.coverage} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function VerdictsView({ runId }: { runId: string }) {
  const { data: verdicts, isLoading } = useVerdicts(runId);
  const { data: coverage } = useCoverage(runId);

  return (
    <div className="grid gap-4">
      {coverage && (
        <Card>
          <CardHeader>Current coverage (live, deterministic)</CardHeader>
          <CardContent className="grid gap-3">
            <CoverageStats c={coverage.current} />
            {coverage.current.perQuestion.length > 0 && (
              <div className="grid gap-1 text-[0.78rem]">
                {coverage.current.perQuestion.map((q) => (
                  <div key={q.question} className="flex items-baseline gap-2">
                    <span className={cn(mono, q.taskStatus === "DONE" ? "text-live" : "text-fail")}>
                      {q.taskStatus.toLowerCase()}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-secondary-foreground">
                      {q.question}
                    </span>
                    <span className={cn(mono, "text-muted-foreground")}>
                      ev {q.evidenceCount} · cl {q.claimCount}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
      {verdicts?.map((v) => (
        <VerdictCard key={v.id} v={v} />
      ))}
      {!isLoading && (verdicts?.length ?? 0) === 0 && (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No evaluator verdicts yet — the run reaches EVALUATING after analysis.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
