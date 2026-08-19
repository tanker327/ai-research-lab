// Attempt inspector (ticket 2.5): per-attempt model calls (tier, tokens,
// cost, latency) and ordered tool calls — the Phase 2 capabilities made
// visible. Superseded attempts render dimmed (liveness made visible, §24).
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { statusChip } from "./Runs";

interface AttemptRow {
  id: string;
  taskId: string;
  attemptNumber: number;
  status: string;
  agentName: string;
  modelTier: string | null;
  error: { category?: string; message?: string } | null;
}
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

function CallsPanel({ attemptId }: { attemptId: string }) {
  const { data } = useQuery({
    queryKey: ["calls", attemptId],
    queryFn: () =>
      get<{ modelCalls: ModelCall[]; toolCalls: ToolCall[] }>(`/attempts/${attemptId}/calls`),
  });
  if (!data) return <div className="faint">loading…</div>;
  const { modelCalls, toolCalls } = data;
  if (modelCalls.length === 0 && toolCalls.length === 0) {
    return (
      <div className="faint">
        no model or tool calls (fake handler era — real calls arrive with Phase 3 agents)
      </div>
    );
  }
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {modelCalls.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th>Tier</th>
              <th>Tokens in/out</th>
              <th>Cost</th>
              <th>Latency</th>
              <th>Finish</th>
            </tr>
          </thead>
          <tbody>
            {modelCalls.map((m) => (
              <tr key={m.id}>
                <td className="mono">{m.model}</td>
                <td>
                  <span className={`chip ${m.modelTier === "frontier" ? "frontier" : ""}`}>
                    {m.modelTier}
                  </span>
                </td>
                <td className="mono soft">
                  {m.inputTokens ?? "—"}/{m.outputTokens ?? "—"}
                </td>
                <td className="mono soft">{m.costUsd !== null ? `$${m.costUsd}` : "—"}</td>
                <td className="mono soft">{m.latencyMs}ms</td>
                <td className="mono faint">{m.finishReason ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {toolCalls.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Tool</th>
              <th>Result</th>
              <th>Latency</th>
            </tr>
          </thead>
          <tbody>
            {toolCalls.map((t) => (
              <tr key={t.id}>
                <td className="mono">{t.seq}</td>
                <td className="mono">{t.toolName}</td>
                <td
                  className={t.error ? "" : "soft"}
                  style={t.error ? { color: "var(--fail)" } : {}}
                >
                  {t.error ? (t.error.message ?? "failed") : (t.responseSnippet ?? "ok")}
                </td>
                <td className="mono faint">{t.latencyMs !== null ? `${t.latencyMs}ms` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function AttemptsView({ runId }: { runId: string }) {
  const { data: attempts } = useQuery({
    queryKey: ["attempts", runId],
    queryFn: () => get<AttemptRow[]>(`/runs/${runId}/attempts`),
    refetchInterval: 3000,
  });
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="card">
      <div className="hd">Attempts · model &amp; tool calls</div>
      <div className="bd" style={{ display: "grid", gap: 8 }}>
        {attempts?.map((a) => (
          <div
            key={a.id}
            className="taskcard"
            style={a.status === "SUPERSEDED" ? { opacity: 0.5 } : {}}
          >
            <button
              type="button"
              onClick={() => setOpen(open === a.id ? null : a.id)}
              style={{ display: "flex", gap: 10, width: "100%", alignItems: "center" }}
            >
              <span className="mono faint">#{a.attemptNumber}</span>
              <span className="mono">{a.agentName}</span>
              <span className={statusChip(a.status)}>{a.status}</span>
              {a.error && (
                <span className="mono" style={{ color: "var(--fail)" }}>
                  {a.error.category}
                </span>
              )}
              <span className="mono faint" style={{ marginLeft: "auto" }}>
                {open === a.id ? "▾" : "▸"}
              </span>
            </button>
            {open === a.id && (
              <div style={{ marginTop: 10 }}>
                <CallsPanel attemptId={a.id} />
              </div>
            )}
          </div>
        ))}
        {(attempts?.length ?? 0) === 0 && <div className="faint">no attempts yet</div>}
      </div>
    </div>
  );
}
