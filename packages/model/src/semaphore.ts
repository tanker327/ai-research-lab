// Client-side per-tier concurrency cap (phase-2-plan D3): bounds in-flight
// calls against GPU-backed tiers without requiring a hub deploy. The hub's
// own queueing remains the backstop.
import type { ModelTier } from "@lab/schemas";

interface Gate {
  inFlight: number;
  limit: number;
  waiters: Array<() => void>;
}

export interface TierLimiter {
  withPermit<T>(tier: ModelTier, fn: () => Promise<T>): Promise<T>;
  inFlight(tier: ModelTier): number;
}

export function createTierLimiter(limits: Partial<Record<ModelTier, number>>): TierLimiter {
  const gates = new Map<ModelTier, Gate>();
  for (const [tier, limit] of Object.entries(limits)) {
    if (limit !== undefined) {
      gates.set(tier as ModelTier, { inFlight: 0, limit, waiters: [] });
    }
  }

  async function acquire(gate: Gate): Promise<void> {
    if (gate.inFlight < gate.limit) {
      gate.inFlight++;
      return;
    }
    await new Promise<void>((resolve) => gate.waiters.push(resolve));
    gate.inFlight++;
  }

  function release(gate: Gate): void {
    gate.inFlight--;
    gate.waiters.shift()?.();
  }

  return {
    async withPermit(tier, fn) {
      const gate = gates.get(tier);
      if (!gate) return fn(); // uncapped tier
      await acquire(gate);
      try {
        return await fn();
      } finally {
        release(gate);
      }
    },
    inFlight: (tier) => gates.get(tier)?.inFlight ?? 0,
  };
}
