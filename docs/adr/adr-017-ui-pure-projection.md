# ADR-017: The UI is a pure projection of stored records

- **Status:** Accepted (new in v0.2.1)
- **Source:** `docs/system-design-v0.2.1.md` §24.8

## Decision

Nothing rendered in the console is reconstructed from chat history or model memory;
every view is a projection of read APIs over stored rows. No SSR need — Vite + React
+ TanStack Query.

## Consequences

- Every attempt's trace is assemblable after a process restart (V0.05 DoD).
- UI bugs are read-path bugs; the write path is unaffected by console work.
