// Read-API client. The console is a pure projection of these endpoints
// (ADR-017). Response DTOs mirror the api's raw-row mappers; when read DTOs
// graduate into @lab/schemas these local types are replaced (rule 2).
import { useQuery } from "@tanstack/react-query";

const BASE = "/api";

export interface RunRow {
  id: string;
  title: string | null;
  userRequest: string;
  status: string;
  budget: Record<string, unknown>;
  evalCycleCount: number;
  createdAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
}

export interface TaskRow {
  id: string;
  runId: string;
  type: string;
  title: string;
  status: string;
  priority: number;
  attemptCount: number;
  maxAttempts: number;
  claimedBy: string | null;
}

export interface EventRow {
  id: string;
  runId: string;
  taskId: string | null;
  attemptId: string | null;
  type: string;
  kind: "info" | "accept" | "gate" | "warn" | "fail";
  actor: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export const useRuns = () =>
  useQuery({ queryKey: ["runs"], queryFn: () => get<RunRow[]>("/runs"), refetchInterval: 3000 });

export const useRun = (id: string) =>
  useQuery({
    queryKey: ["run", id],
    queryFn: () => get<RunRow>(`/runs/${id}`),
    refetchInterval: 2000,
  });

export const useTasks = (runId: string) =>
  useQuery({
    queryKey: ["tasks", runId],
    queryFn: () => get<TaskRow[]>(`/runs/${runId}/tasks`),
    refetchInterval: 2000,
  });

export const useEvents = (runId: string) =>
  useQuery({
    queryKey: ["events", runId],
    queryFn: () => get<EventRow[]>(`/runs/${runId}/events`),
  });

export async function createRun(body: unknown): Promise<{ id: string }> {
  const res = await fetch(`${BASE}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<{ id: string }>;
}

export async function cancelRun(id: string): Promise<void> {
  const res = await fetch(`${BASE}/runs/${id}/cancel`, { method: "POST" });
  if (!res.ok) throw new Error(`cancel failed: ${res.status}`);
}

export function eventStreamUrl(runId: string, after?: string): string {
  return `${BASE}/runs/${runId}/events/stream${after ? `?after=${after}` : ""}`;
}
