// Claim canonicalization (ticket 3.5, design §10, phase-3-plan D6):
// EXTRACT → RESOLVE → UPSERT → LINK over the live raw-claim set. Everything
// here is deterministic code except the optional batch merge-confirm, which a
// caller may back with a fast model — unavailability degrades to "no merge"
// (duplicates survive; nothing is wrongly merged).
import {
  type Db,
  type LiveRawClaimRow,
  selectLiveEvidenceLinkSources,
  selectLiveRawClaims,
  selectTrgmCandidates,
  setRawClaimCanonical,
  updateCanonicalStatus,
  upsertCanonicalClaim,
  upsertClaimEvidenceLink,
} from "@lab/db";
import { newId } from "@lab/schemas";

export const TRGM_THRESHOLD = 0.55;

// Belt normalization — the Extractor prompt already asks for these forms.
export function normalizeKey(key: string): string {
  return key
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9:_\-./]/g, "");
}

export interface MergePair {
  subjectA: string;
  statementA: string;
  subjectB: string;
  statementB: string;
}

// Batch confirm: same order as pairs; true = same real-world subject.
export type MergeConfirmer = (pairs: MergePair[]) => Promise<boolean[]>;

export interface CanonicalizeResult {
  canonicalIds: string[];
  merged: number; // raw groups folded into an existing near-duplicate subject
  contested: number;
  linked: number;
}

export async function canonicalizeRun(
  db: Db,
  runId: string,
  confirmMerges?: MergeConfirmer,
): Promise<CanonicalizeResult> {
  return db.transaction(async (tx) => {
    const raw = await selectLiveRawClaims(tx, runId);

    // RESOLVE: group by normalized exact key.
    const groups = new Map<string, LiveRawClaimRow[]>();
    for (const rc of raw) {
      const key = `${normalizeKey(rc.subjectKey)}|${normalizeKey(rc.predicateKey)}`;
      groups.set(key, [...(groups.get(key) ?? []), rc]);
    }

    const result: CanonicalizeResult = { canonicalIds: [], merged: 0, contested: 0, linked: 0 };
    const rawToCanonical = new Map<string, string>();

    for (const [key, members] of groups) {
      const [subjectKey, predicateKey] = key.split("|") as [string, string];
      const first = members[0];
      if (!first) continue;

      // Candidate near-dup subjects (pg_trgm) confirmed in batch by the
      // caller's fast model — a plain "no" (or no confirmer) means a new row.
      // Merge direction is deterministic: only INTO a subject that sorts
      // earlier, so two spellings converge on one row instead of ping-ponging
      // across re-runs (a canonical row is a pure function of the live set).
      let targetSubject = subjectKey;
      const candidates = (
        await selectTrgmCandidates(tx, runId, subjectKey, predicateKey, TRGM_THRESHOLD)
      ).filter((c) => c.subjectKey < subjectKey);
      if (candidates.length > 0 && confirmMerges) {
        let verdicts: boolean[] = [];
        try {
          verdicts = await confirmMerges(
            candidates.map((c) => ({
              subjectA: subjectKey,
              statementA: first.statement,
              subjectB: c.subjectKey,
              statementB: c.statement,
            })),
          );
        } catch {
          verdicts = []; // degrade to no-merge, never wrongly merge
        }
        const hit = candidates.find((_, i) => verdicts[i] === true);
        if (hit) {
          targetSubject = hit.subjectKey;
          result.merged += 1;
        }
      }

      // UPSERT (unique on run+subject+predicate makes this idempotent).
      const canonicalId = await upsertCanonicalClaim(tx, {
        id: newId(),
        runId,
        subjectKey: targetSubject,
        predicateKey,
        statement: first.statement,
        type: first.type,
      });
      result.canonicalIds.push(canonicalId);

      // Values disagree ⇒ contested + note. That IS the V0.05 contradiction
      // system (design §10).
      const values = [
        ...new Set(members.map((m) => m.valueText).filter((v): v is string => v !== null)),
      ];
      const contested = values.length > 1;
      if (contested) result.contested += 1;
      await updateCanonicalStatus(
        tx,
        canonicalId,
        contested ? "contested" : "supported",
        contested ? `disagreeing values: ${values.join(" vs ")}` : null,
        first.statement,
      );

      for (const m of members) {
        await setRawClaimCanonical(tx, m.id, canonicalId);
        rawToCanonical.set(m.id, canonicalId);
      }
    }

    // LINK: evidence.metadata.rawClaimIds (written by the extractor handler)
    // → claim_evidence_links against the canonical rows.
    const sources = await selectLiveEvidenceLinkSources(tx, runId);
    for (const s of sources) {
      for (const rawId of s.rawClaimIds) {
        const canonicalId = rawToCanonical.get(rawId);
        if (!canonicalId) continue;
        await upsertClaimEvidenceLink(tx, canonicalId, s.id, "supports");
        result.linked += 1;
      }
    }
    return result;
  });
}
