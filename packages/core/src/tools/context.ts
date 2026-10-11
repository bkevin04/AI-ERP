import type { CoreStore, NewProvenanceEntry, PrincipalContext, TenantInfo } from "../store.js";

export interface RunContext {
  id: string;
  /** Returns the next step sequence number for this run. */
  nextSeq(): number;
}

export type ProvenanceChange = Omit<
  NewProvenanceEntry,
  "id" | "runId" | "stepId" | "actorPrincipalId" | "sourceDocumentIds"
> & { sourceDocumentIds?: string[] };

export interface ToolContext {
  /** Tenant-scoped store, already inside the invocation transaction. */
  store: CoreStore;
  tenant: TenantInfo;
  principal: PrincipalContext;
  run: RunContext | null;
  now(): Date;
  /** Source documents the current invocation derives from (propagated to provenance). */
  sourceDocumentIds: string[];
  /** Handlers call this for every state change; invokeTool writes them in the same transaction. */
  recordChange(change: ProvenanceChange): void;
}
