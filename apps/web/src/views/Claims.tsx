// Evidence & claims browser (ticket 3.7): live canonical claims grouped by
// subject, contested highlighted with their disagreement note, per-claim
// evidence with source-class and vendor flags. Superseded attempts' rows are
// already dark — this view only ever sees the live set (ADR-014).
import { useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { type ClaimRow, useClaims } from "../api";

const mono = "font-mono text-[0.72rem]";

function EvidenceLine({ e }: { e: ClaimRow["evidence"][number] }) {
  return (
    <div className="border-l-2 border-border py-1 pl-3 text-[0.78rem]">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={e.relation === "contradicts" ? "fail" : "secondary"}>{e.relation}</Badge>
        <span className={cn(mono, "text-secondary-foreground")}>{e.sourceClass}</span>
        {e.vendorAffiliated && <Badge variant="run">vendor</Badge>}
        {e.benchmarkOrigin && (
          <span className={cn(mono, "text-muted-foreground")}>benchmark: {e.benchmarkOrigin}</span>
        )}
        {e.sourceUrl && (
          <a
            className={cn(mono, "text-live underline-offset-2 hover:underline")}
            href={e.sourceUrl}
            target="_blank"
            rel="noreferrer"
          >
            {e.sourceUrl.replace(/^https?:\/\//, "").slice(0, 60)}
          </a>
        )}
      </div>
      <div className="mt-0.5 text-secondary-foreground">“{e.excerpt.slice(0, 300)}”</div>
    </div>
  );
}

export function ClaimsView({ runId, highlight }: { runId: string; highlight?: string }) {
  const { data: claims, isLoading } = useClaims(runId);
  const bySubject = new Map<string, ClaimRow[]>();
  for (const c of claims ?? []) {
    bySubject.set(c.subjectKey, [...(bySubject.get(c.subjectKey) ?? []), c]);
  }

  // Chip jump-and-flash (6.5, §24.6): a report chip navigates here with the
  // claim id; scroll to it and flash (the CSS animation respects
  // prefers-reduced-motion).
  const loaded = !isLoading && (claims?.length ?? 0) > 0;
  useEffect(() => {
    if (!highlight || !loaded) return;
    const el = document.getElementById(`claim-${highlight}`);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.classList.add("claim-flash");
    const t = setTimeout(() => el.classList.remove("claim-flash"), 2400);
    return () => clearTimeout(t);
  }, [highlight, loaded]);

  if (isLoading) return <div className="text-muted-foreground">loading…</div>;
  if ((claims?.length ?? 0) === 0) {
    return (
      <Card>
        <CardHeader>Claims &amp; evidence</CardHeader>
        <CardContent className="text-muted-foreground">
          no live canonical claims yet — they appear when a research → extract chain is accepted and
          canonicalized
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4.5">
      {[...bySubject.entries()].map(([subject, subjectClaims]) => (
        <Card key={subject}>
          <CardHeader>
            <span className="normal-case tracking-normal text-foreground">{subject}</span>
            <span className="ml-auto">{subjectClaims.length} claims</span>
          </CardHeader>
          <CardContent className="grid gap-3">
            {subjectClaims.map((c) => (
              <div key={c.id} id={`claim-${c.id}`} className="rounded-md">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn(mono, "text-muted-foreground")}>{c.predicateKey}</span>
                  <Badge
                    variant={
                      c.status === "contested"
                        ? "fail"
                        : c.status === "supported"
                          ? "live"
                          : "secondary"
                    }
                  >
                    {c.status}
                  </Badge>
                  <span className="text-[0.85rem]">{c.statement}</span>
                </div>
                {c.contestNote && (
                  <div className="mt-1 rounded-md bg-fail-soft px-3 py-1.5 text-[0.78rem] text-fail">
                    ! {c.contestNote}
                  </div>
                )}
                <div className="mt-1.5 grid gap-1">
                  {c.evidence.map((e) => (
                    <EvidenceLine key={`${c.id}-${e.excerpt.slice(0, 40)}-${e.sourceUrl}`} e={e} />
                  ))}
                  {c.evidence.length === 0 && (
                    <div className={cn(mono, "text-muted-foreground")}>no linked evidence</div>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
