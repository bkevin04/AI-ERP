import { z } from "zod";
import { Uuid } from "./primitives.js";

export const EventType = z.enum([
  "document.received",
  "run.started",
  "run.completed_noop",
  "proposal.created",
  "proposal.approved",
  "proposal.rejected",
  "order.committed",
  "writeback.sent",
  "writeback.confirmed",
  "writeback.failed",
  "reconcile.mismatch",
  "agent.killed",
]);
export type EventType = z.infer<typeof EventType>;

export const Event = z.object({
  id: Uuid,
  tenantId: Uuid,
  type: EventType,
  payload: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string(),
  occurredAt: z.date(),
});
export type Event = z.infer<typeof Event>;

export const RunStatus = z.enum([
  "queued",
  "running",
  "proposed",
  "checking",
  "checks_failed",
  "pending_approval",
  "auto_approved",
  "committing",
  "committed",
  "writing_back",
  "written_back",
  "reconciled",
  "completed_noop",
  "failed",
  "cancelled",
  "killed",
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const StepKind = z.enum(["llm_call", "tool_call", "policy_check", "gate", "code"]);
export type StepKind = z.infer<typeof StepKind>;

export const RunStep = z.object({
  id: Uuid,
  runId: Uuid,
  seq: z.number().int(),
  kind: StepKind,
  name: z.string(),
  input: z.unknown(),
  output: z.unknown(),
  idempotencyKey: z.string(),
  status: z.enum(["ok", "error"]),
  durationMs: z.number().int(),
});
export type RunStep = z.infer<typeof RunStep>;
