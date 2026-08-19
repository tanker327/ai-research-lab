import { useState } from "react";
import { Content, PageTitle, Topbar } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
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

export function NewRunView() {
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (mode: "planner" | "demo") => {
    setBusy(true);
    setErr(null);
    try {
      const { id } = await createRun({
        title: request.slice(0, 60) || (mode === "demo" ? "demo run" : "research run"),
        userRequest: request || "console demo run",
        ...(mode === "demo" ? { tasks: demoTasks() } : {}), // no tasks → Planner
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
