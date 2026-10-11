import { z } from "zod";
import { ConfidenceBreakdown, OrderDraft, PolicyResult, ProposalStatus } from "@ai-erp/contracts";
import { evaluatePolicy, type PolicyThresholds } from "../../policy/checks.js";
import { computeConfidence } from "../../policy/confidence.js";
import { newId } from "../../util.js";
import { defineTool } from "../define.js";

export const PROPOSAL_PAYLOAD_SCHEMA_VERSION = 1;

export const createOrderProposal = defineTool({
  name: "create_order_proposal",
  description: "Turn an order draft into a proposal: computes deterministic confidence, runs the versioned policy, decides whether it needs a human, and records provenance. Never commits an order.",
  scope: "orders:propose",
  sideEffects: "write",
  exposure: ["http", "agent", "mcp"],
  idempotency: "required",
  input: z.object({
    draft: OrderDraft,
    explanation: z.string(),
    promptVersion: z.string().nullable().default(null),
    modelId: z.string().nullable().default(null),
  }),
  output: z.object({
    proposalId: z.uuid(),
    status: ProposalStatus,
    confidence: z.number(),
    confidenceBreakdown: ConfidenceBreakdown,
    policyResult: PolicyResult,
  }),
  handler: async (ctx, input) => {
    const confidence = computeConfidence(input.draft);
    const thresholds = (ctx.tenant.settings["policyThresholds"] ?? undefined) as Partial<PolicyThresholds> | undefined;
    const policyResult = evaluatePolicy({
      draft: input.draft,
      confidence,
      agentPolicy: ctx.principal.policy,
      thresholds,
    });

    let status: z.infer<typeof ProposalStatus>;
    if (policyResult.decision === "block") status = "checks_failed";
    else if (policyResult.decision === "review") status = "pending_approval";
    else {
      const gateGreen = await ctx.store.isAutonomyGateGreen(ctx.tenant.id);
      const autonomous =
        ctx.tenant.autonomyLevel === 2 &&
        ctx.tenant.agentsPausedAt === null &&
        ctx.principal.kind === "agent" &&
        ctx.principal.policy?.autoCommitEnabled === true &&
        gateGreen;
      status = autonomous ? "auto_approved" : "pending_approval";
      if (!autonomous) {
        policyResult.reasons.push({
          code: "autonomy_not_enabled",
          message: gateGreen ? "tenant autonomy level or agent policy does not allow auto-commit" : "autonomy gate is not green",
          severity: "info",
        });
      }
    }

    const proposalId = newId();
    const flags = [...new Set([...input.draft.flags, ...input.draft.lines.flatMap((l) => l.flags)])];
    await ctx.store.insertProposal({
      id: proposalId,
      runId: ctx.run?.id ?? null,
      kind: "create_order",
      payload: input.draft,
      payloadSchemaVersion: PROPOSAL_PAYLOAD_SCHEMA_VERSION,
      confidence: confidence.overall,
      confidenceBreakdown: confidence,
      flags,
      explanation: input.explanation,
      policyResult,
      status,
      supersedesId: null,
    });
    await ctx.store.insertEvent({
      id: newId(),
      type: "proposal.created",
      payload: { proposalId, status, decision: policyResult.decision, runId: ctx.run?.id ?? null },
      idempotencyKey: `proposal.created:${proposalId}`,
    });
    ctx.recordChange({
      entityType: "proposal",
      entityId: proposalId,
      entityVersion: 1,
      action: "proposal.created",
      proposalId,
      approvalId: null,
      policyVersion: policyResult.policyVersion,
      promptVersion: input.promptVersion,
      modelId: input.modelId,
      diff: { status, decision: policyResult.decision, confidence: confidence.overall, flags },
    });

    return { proposalId, status, confidence: confidence.overall, confidenceBreakdown: confidence, policyResult };
  },
});
