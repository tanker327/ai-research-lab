// Shared §24.2 trace-block renderer (ticket 6.1, D2): ONE component behind
// both the transcript reading mode and the inspector's trace viewer. Blocks
// are color-coded by kind per the mockup (context/reasoning/tool/output/
// control; control turns red when a rejection is present) and collapsible.
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { TraceBlockDto } from "../api";

const mono = "font-mono text-[0.72rem]";

// Mockup block palette: each kind gets a colored left rail.
const KIND_RAIL: Record<TraceBlockDto["kind"], string> = {
  context_in: "border-live",
  reasoning: "border-frontier",
  tool_call: "border-run",
  output: "border-input",
  control: "border-border",
};

function Json({ value }: { value: unknown }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-md bg-muted/40 px-3 py-2 font-mono text-[0.68rem] leading-relaxed">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function Collapsed({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(mono, "flex cursor-pointer items-center gap-1.5 text-muted-foreground")}
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        {label}
      </button>
      {open && <div className="mt-1.5">{children}</div>}
    </div>
  );
}

function BlockBody({ block }: { block: TraceBlockDto }) {
  switch (block.kind) {
    case "context_in":
      return (
        <Collapsed label="context in — the verbatim Context Builder product (R12)">
          <Json value={block.input} />
        </Collapsed>
      );
    case "reasoning":
      return (
        <div className={cn(mono, "text-muted-foreground")}>
          reasoning · {block.artifacts.map((a) => a.name).join(", ")}
          <span className="ml-1.5 opacity-70">(display-only — never fed to agents, ADR-018)</span>
        </div>
      );
    case "tool_call":
      return (
        <div className="flex flex-wrap items-baseline gap-2 text-[0.78rem]">
          <span className={cn(mono, "text-muted-foreground")}>#{block.call.seq}</span>
          <span className={mono}>{block.call.toolName}</span>
          <span className={block.call.error ? "text-fail" : "text-secondary-foreground"}>
            {block.call.error
              ? (block.call.error.message ?? "failed")
              : (block.call.responseSnippet?.slice(0, 140) ?? "ok")}
          </span>
          {block.call.latencyMs !== null && (
            <span className={cn(mono, "text-muted-foreground")}>{block.call.latencyMs}ms</span>
          )}
        </div>
      );
    case "output":
      return (
        <div className="grid gap-1.5">
          {block.error ? (
            <div className="rounded-md bg-fail-soft px-3 py-1.5 text-[0.78rem] text-fail">
              {String(block.error.category ?? "error")} — {String(block.error.message ?? "")}
            </div>
          ) : (
            <Collapsed label="output">
              <Json value={block.output} />
            </Collapsed>
          )}
          {block.artifacts.length > 0 && (
            <div className={cn(mono, "text-muted-foreground")}>
              artifacts · {block.artifacts.map((a) => `${a.name} (${a.type})`).join(", ")}
            </div>
          )}
        </div>
      );
    case "control":
      return (
        <div className="grid gap-1">
          {block.entries.map((e) => (
            <div
              key={`${e.source}-${e.type}-${e.createdAt}`}
              className="flex flex-wrap items-baseline gap-2 text-[0.74rem]"
            >
              <Badge
                variant={
                  e.kind === "fail" || e.decision === "REJECT"
                    ? "fail"
                    : e.kind === "accept"
                      ? "live"
                      : "secondary"
                }
              >
                {e.source}
              </Badge>
              <span className={mono}>{e.type}</span>
              {e.decision && <span className={cn(mono, "text-run")}>{e.decision}</span>}
              <span className="text-secondary-foreground">{e.detail.slice(0, 220)}</span>
            </div>
          ))}
        </div>
      );
  }
}

function controlRejected(block: TraceBlockDto): boolean {
  return (
    block.kind === "control" &&
    block.entries.some((e) => e.decision === "REJECT" || e.kind === "fail")
  );
}

export function TraceBlocks({ attemptId, blocks }: { attemptId: string; blocks: TraceBlockDto[] }) {
  return (
    <div className="grid gap-2.5">
      {blocks.map((b) => (
        <div
          key={`${attemptId}-${b.kind}-${b.kind === "tool_call" ? b.call.id : "1"}`}
          className={cn("border-l-2 pl-3", controlRejected(b) ? "border-fail" : KIND_RAIL[b.kind])}
        >
          <BlockBody block={b} />
        </div>
      ))}
    </div>
  );
}
