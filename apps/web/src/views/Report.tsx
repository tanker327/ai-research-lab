// Report view (ticket 5.4, §24.4/§24.6): the accepted synthesis rendered with
// interactive citation chips. Clicking a chip resolves it through the
// citations API (chip → claims → live evidence) in a detail panel — the
// click-a-chip-jump-to-evidence interaction the citationMap exists for.
// Deliberately tiny markdown subset (headings, bullets, paragraphs): the
// Synthesizer's report structure is validator-enforced, and §2's locked stack
// carries no markdown library.
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { navigate } from "../App";
import { type CitationDto, useCitations, useReport } from "../api";

const mono = "font-mono text-[0.72rem]";
const CHIP = /(\[c\d+\])/g;

function ChipText({
  text,
  selected,
  onChip,
}: {
  text: string;
  selected: string | null;
  onChip: (chip: string) => void;
}) {
  // Character offsets make stable keys — the split is positional, not a list
  // that reorders.
  let offset = 0;
  const parts = text.split(CHIP).map((part) => {
    const p = { part, at: offset };
    offset += part.length;
    return p;
  });
  return (
    <>
      {parts.map(({ part, at }) => {
        const m = /^\[(c\d+)\]$/.exec(part);
        if (!m) return <span key={`t${at}`}>{part}</span>;
        const chip = m[1] as string;
        return (
          <button
            key={`c${at}`}
            type="button"
            onClick={() => onChip(chip)}
            className={cn(
              "mx-0.5 inline-block cursor-pointer rounded border px-1 align-baseline font-mono text-[0.62rem] leading-[1.1rem]",
              selected === chip
                ? "border-run bg-run-soft text-run"
                : "border-border text-muted-foreground hover:border-run hover:text-run",
            )}
          >
            {chip}
          </button>
        );
      })}
    </>
  );
}

function CitationPanel({ citation, runId }: { citation: CitationDto; runId: string }) {
  return (
    <Card className="border-run">
      <CardHeader>
        <span className={cn(mono, "text-run")}>[{citation.chip}]</span>
        <span className="ml-2">cited claims</span>
        <button
          type="button"
          onClick={() => navigate(`/run/${runId}/evidence`)}
          className={cn(
            mono,
            "ml-auto cursor-pointer text-live underline-offset-2 hover:underline",
          )}
        >
          open evidence browser →
        </button>
      </CardHeader>
      <CardContent className="grid gap-3">
        {citation.claims.map((claim) => (
          <div key={claim.id}>
            <div className="flex flex-wrap items-center gap-2 text-[0.82rem]">
              {claim.status && (
                <Badge variant={claim.status === "contested" ? "fail" : "live"}>
                  {claim.status}
                </Badge>
              )}
              <span>{claim.statement ?? `claim ${claim.id} is no longer live`}</span>
            </div>
            {claim.evidence.map((e) => (
              <div
                key={`${claim.id}-${e.excerpt.slice(0, 40)}`}
                className="mt-1 border-l-2 border-border pl-3 text-[0.76rem] text-secondary-foreground"
              >
                <span className={cn(mono, "mr-1.5 text-muted-foreground")}>{e.sourceClass}</span>
                {e.vendorAffiliated && (
                  <Badge variant="run" className="mr-1.5">
                    vendor
                  </Badge>
                )}
                “{e.excerpt.slice(0, 240)}”
                {e.sourceUrl && (
                  <a
                    className={cn(mono, "ml-1.5 text-live underline-offset-2 hover:underline")}
                    href={e.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {e.sourceUrl.replace(/^https?:\/\//, "").slice(0, 50)}
                  </a>
                )}
              </div>
            ))}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function ReportView({ runId }: { runId: string }) {
  const { data: report, isLoading } = useReport(runId);
  const { data: citations } = useCitations(runId, report != null);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedCitation = citations?.find((c) => c.chip === selected) ?? null;

  if (isLoading) return <div className="text-muted-foreground">loading…</div>;
  if (!report) {
    return (
      <Card>
        <CardHeader>Report</CardHeader>
        <CardContent className="text-muted-foreground">
          no report yet — it appears when the Evaluator accepts the analysis and the Synthesizer's
          draft passes the citation validator (ADR-020)
        </CardContent>
      </Card>
    );
  }

  const lines = (report.markdown ?? "").split("\n");
  let inUncertainties = false;
  const onChip = (chip: string) => setSelected(selected === chip ? null : chip);

  return (
    <div className="grid gap-4.5">
      <Card>
        <CardHeader>
          <span className="normal-case tracking-normal font-serif text-[1.05rem] text-foreground">
            {report.title ?? "Report"}
          </span>
          <span className={cn(mono, "ml-auto text-muted-foreground")}>
            {Object.keys(report.citationMap).length} citations · every sentence provenanced
          </span>
        </CardHeader>
        <CardContent className="grid max-w-[72ch] gap-2 text-[0.88rem] leading-relaxed">
          {lines.map((raw, i) => {
            const line = raw.trim();
            const key = `${i}-${line.slice(0, 24)}`;
            if (line === "") return null;
            const heading = /^(#{1,6})\s+(.*)$/.exec(line);
            if (heading) {
              inUncertainties = /^uncertaint/i.test((heading[2] ?? "").trim());
              return (
                <h3
                  key={key}
                  className={cn("mt-3 font-serif text-[1rem]", inUncertainties && "text-run")}
                >
                  {heading[2]}
                </h3>
              );
            }
            const bullet = /^[-*+]\s+(.*)$/.exec(line);
            const body = bullet ? (bullet[1] as string) : line;
            return (
              <div
                key={key}
                className={cn(
                  bullet && "border-l-2 border-border pl-3",
                  inUncertainties && "rounded-md bg-run-soft px-3 py-1.5 text-[0.82rem]",
                )}
              >
                <ChipText text={body} selected={selected} onChip={onChip} />
              </div>
            );
          })}
        </CardContent>
      </Card>
      {selectedCitation && <CitationPanel citation={selectedCitation} runId={runId} />}
    </div>
  );
}
