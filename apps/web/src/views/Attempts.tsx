// Attempt inspector (ticket 2.5): per-attempt model calls (tier, tokens,
// cost, latency) and ordered tool calls — the Phase 2 capabilities made
// visible. Superseded attempts render dimmed (liveness made visible, §24).
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { useAttempts } from "../api";

interface ModelCall {
  id: string;
  model: string;
  modelTier: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  latencyMs: number;
  finishReason: string | null;
}
interface ToolCall {
  id: string;
  seq: number;
  toolName: string;
  responseSnippet: string | null;
  error: { message?: string } | null;
  latencyMs: number | null;
}

const get = async <T,>(path: string): Promise<T> => {
  const res = await fetch(`/api${path}`);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
};

const mono = "font-mono text-[0.76rem]";

function CallsPanel({ attemptId }: { attemptId: string }) {
  const { data } = useQuery({
    queryKey: ["calls", attemptId],
    queryFn: () =>
      get<{ modelCalls: ModelCall[]; toolCalls: ToolCall[] }>(`/attempts/${attemptId}/calls`),
  });
  if (!data) return <div className="text-muted-foreground">loading…</div>;
  const { modelCalls, toolCalls } = data;
  if (modelCalls.length === 0 && toolCalls.length === 0) {
    return (
      <div className="text-muted-foreground">
        no model or tool calls (fake handler era — real calls arrive with Phase 3 agents)
      </div>
    );
  }
  return (
    <div className="grid gap-2.5">
      {modelCalls.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead>Tier</TableHead>
              <TableHead>Tokens in/out</TableHead>
              <TableHead>Cost</TableHead>
              <TableHead>Latency</TableHead>
              <TableHead>Finish</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {modelCalls.map((m) => (
              <TableRow key={m.id}>
                <TableCell className={mono}>{m.model}</TableCell>
                <TableCell>
                  <Badge variant={m.modelTier === "frontier" ? "frontier" : "secondary"}>
                    {m.modelTier}
                  </Badge>
                </TableCell>
                <TableCell className={cn(mono, "text-secondary-foreground")}>
                  {m.inputTokens ?? "—"}/{m.outputTokens ?? "—"}
                </TableCell>
                <TableCell className={cn(mono, "text-secondary-foreground")}>
                  {m.costUsd !== null ? `$${m.costUsd}` : "—"}
                </TableCell>
                <TableCell className={cn(mono, "text-secondary-foreground")}>
                  {m.latencyMs}ms
                </TableCell>
                <TableCell className={cn(mono, "text-muted-foreground")}>
                  {m.finishReason ?? "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {toolCalls.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>Tool</TableHead>
              <TableHead>Result</TableHead>
              <TableHead>Latency</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {toolCalls.map((t) => (
              <TableRow key={t.id}>
                <TableCell className={mono}>{t.seq}</TableCell>
                <TableCell className={mono}>{t.toolName}</TableCell>
                <TableCell className={t.error ? "text-fail" : "text-secondary-foreground"}>
                  {t.error ? (t.error.message ?? "failed") : (t.responseSnippet ?? "ok")}
                </TableCell>
                <TableCell className={cn(mono, "text-muted-foreground")}>
                  {t.latencyMs !== null ? `${t.latencyMs}ms` : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

export function AttemptsView({ runId }: { runId: string }) {
  const { data: attempts } = useAttempts(runId);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader>Attempts · model &amp; tool calls</CardHeader>
      <CardContent className="grid gap-2">
        {attempts?.map((a) => (
          <div
            key={a.id}
            className={cn(
              "rounded-md border bg-card px-3 py-2.5 text-[0.8rem]",
              a.status === "SUPERSEDED" && "opacity-50",
            )}
          >
            <button
              type="button"
              onClick={() => setOpen(open === a.id ? null : a.id)}
              className="flex w-full cursor-pointer items-center gap-2.5"
            >
              <span className={cn(mono, "text-muted-foreground")}>#{a.attemptNumber}</span>
              <span className={mono}>{a.agentName}</span>
              <StatusBadge status={a.status} />
              {a.error && <span className={cn(mono, "text-fail")}>{a.error.category}</span>}
              <span className="ml-auto text-muted-foreground">
                {open === a.id ? (
                  <ChevronDown className="size-3.5" />
                ) : (
                  <ChevronRight className="size-3.5" />
                )}
              </span>
            </button>
            {open === a.id && (
              <div className="mt-2.5">
                <CallsPanel attemptId={a.id} />
              </div>
            )}
          </div>
        ))}
        {(attempts?.length ?? 0) === 0 && (
          <div className="text-muted-foreground">no attempts yet</div>
        )}
      </CardContent>
    </Card>
  );
}
