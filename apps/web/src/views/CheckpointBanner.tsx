// Checkpoint resolution banner (ticket 6.4, D5): the three verbs, offered
// only where they are legal — retry for a failed analysis/synthesis, accept
// only past a cycle guard, stop anywhere. The note travels into the
// DecisionRecord as the human rationale.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { navigate } from "../App";
import { type CheckpointRow, resolveCheckpoint } from "../api";

const RETRYABLE = new Set(["analysis_failed", "synthesis_failed"]);

export function CheckpointBanner({ runId, cp }: { runId: string; cp: CheckpointRow }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (action: "retry" | "accept" | "stop") => {
    setBusy(true);
    setError(null);
    try {
      await resolveCheckpoint(runId, cp.id, action, note);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-2">
      <div>
        <span className="mr-2 font-mono text-[0.68rem] uppercase tracking-[0.06em] text-muted-foreground">
          {cp.reason}
        </span>
        {cp.question}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="rationale (recorded on the decision)"
          className="min-w-56 flex-1 rounded-md border bg-card px-2.5 py-1.5 text-[0.78rem] placeholder:text-muted-foreground"
        />
        {cp.reason === "plan_review" && (
          <Button size="sm" onClick={() => navigate(`/run/${runId}/review`)}>
            Open plan review →
          </Button>
        )}
        {RETRYABLE.has(cp.reason) && (
          <Button size="sm" disabled={busy} onClick={() => act("retry")}>
            Retry
          </Button>
        )}
        {cp.reason === "cycle_guard" && (
          <Button size="sm" disabled={busy} onClick={() => act("accept")}>
            Accept &amp; synthesize
          </Button>
        )}
        <Button size="sm" variant="destructive" disabled={busy} onClick={() => act("stop")}>
          Stop run
        </Button>
      </div>
      {error && (
        <div className={cn("font-mono text-[0.7rem] text-fail")}>{error.slice(0, 200)}</div>
      )}
    </div>
  );
}
