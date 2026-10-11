import type { PolicyDecision } from "@ai-erp/contracts";
import { runOrderIntake, type IntakeEnv, type PreparedDocument } from "@ai-erp/core";
import type { EvalCaseFile } from "./cases.js";
import { aggregate, scoreCase, type AggregateScores, type CaseScore } from "./score.js";

export interface ReplayResult {
  perCase: Array<{ id: string; score: CaseScore | null; decision: PolicyDecision | "noop"; error: string | null }>;
  aggregate: AggregateScores;
}

/**
 * Runs the intake pipeline over stored cases and scores each proposal against the approved
 * truth. The caller supplies an environment factory, so the same replay works against the
 * in-memory store (unit tests) or a pinned Postgres snapshot (nightly eval).
 */
export async function replayCases(
  cases: Array<{ file: EvalCaseFile; documents: PreparedDocument[] }>,
  envFor: (caseId: string) => Promise<IntakeEnv>,
): Promise<ReplayResult> {
  const perCase: ReplayResult["perCase"] = [];
  for (const c of cases) {
    try {
      const env = await envFor(c.file.id);
      const out = await runOrderIntake(env, { documents: c.documents, senderEmail: c.file.senderEmail });
      if (out.kind === "noop") { perCase.push({ id: c.file.id, score: null, decision: "noop", error: null }); continue; }
      perCase.push({ id: c.file.id, score: scoreCase(out.draft, c.file.truth), decision: out.policyResult.decision, error: null });
    } catch (err) {
      perCase.push({ id: c.file.id, score: null, decision: "noop", error: err instanceof Error ? err.message : String(err) });
    }
  }
  const scored = perCase.filter((p): p is typeof p & { score: CaseScore; decision: PolicyDecision } => p.score !== null && p.decision !== "noop");
  return { perCase, aggregate: aggregate(scored.map((p) => ({ score: p.score, decision: p.decision }))) };
}
