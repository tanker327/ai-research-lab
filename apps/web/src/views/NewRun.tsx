import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Content, PageTitle, Topbar } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { navigate } from "../App";
import { createRun } from "../api";

// Planner-driven since 3.7: submitting a question seeds a stage-1 plan task
// and staged planning grows the DAG (ADR-011). The Phase-1 fake demo chain
// stays behind a toggle — it exercises the engine with zero model spend.
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

// 7.1 (phase-7-plan D4): per-role TIER preference. "policy" = no override —
// the §5.6 routing table decides (shown as the default). Tiers only; real
// model names stay deployment config.
const ROLES = [
  "planner",
  "researcher",
  "extractor",
  "analyst",
  "evaluator",
  "synthesizer",
] as const;
const TIERS = ["policy", "frontier", "strong_local", "fast_local"] as const;
const POLICY_DEFAULT: Record<(typeof ROLES)[number], string> = {
  planner: "frontier",
  researcher: "strong_local",
  extractor: "fast_local",
  analyst: "strong_local",
  evaluator: "frontier",
  synthesizer: "frontier",
};

export function NewRunView() {
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showRouting, setShowRouting] = useState(false);
  const [tiers, setTiers] = useState<Record<string, string>>({});

  const submit = async (mode: "planner" | "demo") => {
    setBusy(true);
    setErr(null);
    const roleTiers = Object.fromEntries(Object.entries(tiers).filter(([, t]) => t !== "policy"));
    try {
      const { id } = await createRun({
        title: request.slice(0, 60) || (mode === "demo" ? "demo run" : "research run"),
        userRequest: request || "console demo run",
        ...(mode === "demo" ? { tasks: demoTasks() } : {}), // no tasks → Planner
        ...(Object.keys(roleTiers).length > 0 ? { roleTiers } : {}),
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
      <Topbar>
        <PageTitle>New research</PageTitle>
      </Topbar>
      <Content>
        <Card>
          <CardHeader>Research request</CardHeader>
          <CardContent className="grid gap-3">
            <Textarea
              rows={3}
              placeholder="What should the lab research? The Planner turns this into a staged research plan — discovery first, deep tasks once it knows what exists."
              value={request}
              onChange={(e) => setRequest(e.target.value)}
            />
            <button
              type="button"
              onClick={() => setShowRouting(!showRouting)}
              className="flex cursor-pointer items-center gap-1.5 font-mono text-[0.72rem] text-muted-foreground hover:text-foreground"
            >
              {showRouting ? (
                <ChevronDown className="size-3" />
              ) : (
                <ChevronRight className="size-3" />
              )}
              model routing · per-agent tier{" "}
              {Object.values(tiers).some((t) => t !== "policy")
                ? "(customized)"
                : "(policy defaults)"}
            </button>
            {showRouting && (
              <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-2.5">
                {ROLES.map((role) => (
                  <label key={role} className="grid gap-1 text-[0.76rem]">
                    <span className="font-mono text-[0.66rem] uppercase tracking-[0.06em] text-muted-foreground">
                      {role}
                    </span>
                    <select
                      value={tiers[role] ?? "policy"}
                      onChange={(e) => setTiers({ ...tiers, [role]: e.target.value })}
                      className={cn(
                        "rounded-md border bg-card px-2 py-1.5 font-mono text-[0.74rem]",
                        (tiers[role] ?? "policy") !== "policy" && "border-run",
                      )}
                    >
                      {TIERS.map((t) => (
                        <option key={t} value={t}>
                          {t === "policy" ? `policy (${POLICY_DEFAULT[role]})` : t}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2.5">
              <Button onClick={() => submit("planner")} disabled={busy || !request.trim()}>
                {busy ? "Starting…" : "Start research"}
              </Button>
              <span className="font-mono text-[0.76rem] text-muted-foreground">
                planner · stage-1 discovery → extract → canonical claims → stage 2
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto font-mono text-[0.72rem] text-muted-foreground"
                onClick={() => submit("demo")}
                disabled={busy}
              >
                run fake demo chain instead (no model spend)
              </Button>
            </div>
            {err && <div className="text-fail">{err}</div>}
          </CardContent>
        </Card>
      </Content>
    </>
  );
}
