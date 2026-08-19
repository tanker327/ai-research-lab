import { navigate } from "../App";
import { type RunRow, useRuns } from "../api";

export function statusChip(status: string): string {
  if (["COMPLETED", "DONE", "ACCEPTED"].includes(status)) return "chip live";
  if (["FAILED", "CANCELLED"].includes(status)) return "chip fail";
  if (["CREATED"].includes(status)) return "chip";
  return "chip run"; // any active phase
}

export function RunsView() {
  const { data: runs, isLoading, error } = useRuns();
  return (
    <>
      <div className="topbar">
        <h2>Runs</h2>
        <span className="mono faint">{runs?.length ?? 0} total</span>
      </div>
      <div className="content">
        <div className="card">
          {isLoading && <div className="bd faint">loading…</div>}
          {error && (
            <div className="bd" style={{ color: "var(--fail)" }}>
              {String(error)}
            </div>
          )}
          {runs && (
            <table>
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Status</th>
                  <th>Cycles</th>
                  <th>Created</th>
                  <th>Finished</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r: RunRow) => (
                  <tr key={r.id} className="rowlink" onClick={() => navigate(`/run/${r.id}`)}>
                    <td>
                      <div>{r.title ?? r.userRequest}</div>
                      <div className="mono faint">{r.id}</div>
                    </td>
                    <td>
                      <span className={statusChip(r.status)}>{r.status}</span>
                    </td>
                    <td className="mono soft">{r.evalCycleCount}</td>
                    <td className="mono faint">{r.createdAt.slice(0, 19)}</td>
                    <td className="mono faint">{r.completedAt?.slice(0, 19) ?? "—"}</td>
                  </tr>
                ))}
                {runs.length === 0 && (
                  <tr>
                    <td colSpan={5} className="faint">
                      No runs yet — start one under “New research”.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
