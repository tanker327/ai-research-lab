import { useState } from "react";
import { Content, PageTitle, Topbar } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
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
      <Topbar>
        <PageTitle>New research</PageTitle>
      </Topbar>
      <Content>
        <Card>
          <CardHeader>Research request</CardHeader>
          <CardContent className="grid gap-3">
            <Textarea
              rows={3}
              placeholder="What should the lab research? (free text — Phase 1 runs a fake demo task chain; the Planner turns this into a real plan in Phase 3)"
              value={request}
              onChange={(e) => setRequest(e.target.value)}
            />
            <div className="flex items-center gap-2.5">
              <Button onClick={submit} disabled={busy}>
                {busy ? "Starting…" : "Start run (demo task chain)"}
              </Button>
              <span className="font-mono text-[0.76rem] text-muted-foreground">
                seeds 4 fake tasks · 3 dependency waves · Planner arrives P3
              </span>
            </div>
            {err && <div className="text-fail">{err}</div>}
          </CardContent>
        </Card>
      </Content>
    </>
  );
}
