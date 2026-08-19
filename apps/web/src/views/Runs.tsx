import { Content, PageTitle, Topbar } from "@/components/layout";
import { StatusBadge } from "@/components/status-badge";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { navigate } from "../App";
import { type RunRow, useRuns } from "../api";

export function RunsView() {
  const { data: runs, isLoading, error } = useRuns();
  return (
    <>
      <Topbar>
        <PageTitle>Runs</PageTitle>
        <span className="font-mono text-[0.76rem] text-muted-foreground">
          {runs?.length ?? 0} total
        </span>
      </Topbar>
      <Content>
        <Card>
          {isLoading && <div className="p-4 text-muted-foreground">loading…</div>}
          {error && <div className="p-4 text-fail">{String(error)}</div>}
          {runs && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Run</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Cycles</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Finished</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((r: RunRow) => (
                  <TableRow key={r.id} data-clickable onClick={() => navigate(`/run/${r.id}`)}>
                    <TableCell>
                      <div>{r.title ?? r.userRequest}</div>
                      <div className="font-mono text-[0.76rem] text-muted-foreground">{r.id}</div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={r.status} />
                    </TableCell>
                    <TableCell className="font-mono text-[0.76rem] text-secondary-foreground">
                      {r.evalCycleCount}
                    </TableCell>
                    <TableCell className="font-mono text-[0.76rem] text-muted-foreground">
                      {r.createdAt.slice(0, 19)}
                    </TableCell>
                    <TableCell className="font-mono text-[0.76rem] text-muted-foreground">
                      {r.completedAt?.slice(0, 19) ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
                {runs.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-muted-foreground">
                      No runs yet — start one under “New research”.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </Card>
      </Content>
    </>
  );
}
