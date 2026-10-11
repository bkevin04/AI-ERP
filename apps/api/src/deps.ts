import type { CoreStore, PrincipalContext, ToolRegistry } from "@ai-erp/core";
import type { JobQueue, ObjectStore } from "@ai-erp/platform";

/** What a tenant-scoped store must offer the API beyond the core contract. */
export type ApiTenantStore = CoreStore & {
  listProposals(statuses: string[], limit?: number): Promise<unknown[]>;
};

/** The root (not yet tenant-scoped) store the API boots with. */
export interface ApiStoreRoot {
  resolvePrincipalByApiKeyHash(keyHash: string): Promise<PrincipalContext | null>;
  resolveInboundMailbox(slug: string): Promise<{ tenantId: string; principalId: string } | null>;
  forTenant(tenantId: string): ApiTenantStore;
}

export interface ApiDeps {
  registry: ToolRegistry;
  store: ApiStoreRoot;
  objects: ObjectStore;
  queue: JobQueue;
  globalPause: boolean;
  postmarkToken: string | null;
}
