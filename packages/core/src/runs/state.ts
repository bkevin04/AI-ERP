import type { RunStatus } from "@ai-erp/contracts";

const TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  queued: ["running", "cancelled", "killed"],
  running: ["proposed", "completed_noop", "failed", "cancelled", "killed"],
  proposed: ["checking", "failed", "killed"],
  checking: ["checks_failed", "pending_approval", "auto_approved", "failed", "killed"],
  checks_failed: [],
  pending_approval: ["committing", "cancelled"],
  auto_approved: ["committing", "killed"],
  committing: ["committed", "failed", "killed"],
  committed: ["writing_back"],
  writing_back: ["written_back", "failed"],
  written_back: ["reconciled"],
  reconciled: [],
  completed_noop: [],
  failed: ["queued"],
  cancelled: [],
  killed: [],
};

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransition(from, to)) throw new Error(`illegal run transition ${from} -> ${to}`);
}

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "checks_failed", "reconciled", "completed_noop", "cancelled", "killed",
]);
