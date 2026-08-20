// Deterministic CoverageSummary computation (ticket 4.1, phase-4-plan D2).
// Pure reads over live_* views; the result is what the Evaluator reasons over
// and what gets persisted on the evaluation row (evaluations.metadata.coverage)
// so cycles are comparable. Zod-parsed on the way out: a summary that violates
// its own schema is a computation bug and must fail loudly here, not inside an
// Evaluator context build.
import {
  type Db,
  selectCoverageOverall,
  selectCoveragePerQuestion,
  selectSourceClassMix,
} from "@lab/db";
import { CoverageSummary } from "@lab/schemas";

export async function computeCoverage(db: Db, runId: string): Promise<CoverageSummary> {
  const [overall, mix, perQuestion] = await Promise.all([
    selectCoverageOverall(db, runId),
    selectSourceClassMix(db, runId),
    selectCoveragePerQuestion(db, runId),
  ]);
  return CoverageSummary.parse({
    evidenceCount: overall.evidenceCount,
    claimCount: overall.claimCount,
    contestedCount: overall.contestedCount,
    distinctPublishers: overall.distinctPublishers,
    distinctOrigins: overall.distinctOrigins,
    vendorRatio: overall.vendorRatio,
    sourceClassMix: mix.slice(0, 20),
    perQuestion: perQuestion.slice(0, 40).map((q) => ({
      ...q,
      question: q.question.slice(0, 500),
    })),
    oldestEvidence: overall.oldestEvidence,
    newestEvidence: overall.newestEvidence,
  });
}
