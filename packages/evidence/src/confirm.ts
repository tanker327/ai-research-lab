// Model-backed merge confirmation (D6): one cheap fast-tier call per batch.
// Any failure degrades to "no merge" upstream (canonicalize.ts catches).
import type { ModelClient } from "@lab/model";
import { z } from "zod";
import type { MergeConfirmer, MergePair } from "./canonicalize";

const Verdicts = z.object({ merges: z.array(z.boolean()).max(50) });

// Hard wall-clock cap: a live merge-confirm HTTP call once hung forever and
// (pre-fix) starved the scheduler pool. The confirmer must ALWAYS settle —
// timeout degrades to no-merge via the caller's catch.
const CONFIRM_TIMEOUT_MS = 60_000;

export function createModelMergeConfirmer(
  model: ModelClient,
  modelAlias: string,
  runId: string,
  attemptId: string,
): MergeConfirmer {
  return async (pairs: MergePair[]) => {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`merge-confirm timed out after ${CONFIRM_TIMEOUT_MS}ms`)),
        CONFIRM_TIMEOUT_MS,
      ).unref?.();
    });
    const res = await Promise.race([
      timeout,
      model.generateStructured({
        ctx: {
          runId,
          attemptId,
          tier: "fast_local",
          purpose: "canonical_merge",
          createdBy: "canonicalizer",
        },
        model: modelAlias,
        schema: Verdicts,
        schemaName: "merge_verdicts",
        mode: "json_object",
        temperature: 0,
        maxOutputTokens: 1000,
        system:
          'You judge whether two subject keys refer to the SAME real-world entity. Answer with {"merges": [true/false, ...]} — one boolean per pair, in order. Different sizes, versions, or variants of a model family are DIFFERENT subjects.',
        messages: [
          {
            role: "user",
            content: pairs
              .map(
                (p, i) =>
                  `${i + 1}. A: '${p.subjectA}' ("${p.statementA.slice(0, 120)}") vs B: '${p.subjectB}' ("${p.statementB.slice(0, 120)}")`,
              )
              .join("\n"),
          },
        ],
      }),
    ]);
    const parsed = Verdicts.parse(res.object);
    return pairs.map((_, i) => parsed.merges[i] === true);
  };
}
