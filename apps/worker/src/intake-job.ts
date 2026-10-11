import { z } from "zod";
import { RunKilledError, createDefaultRegistry, createStepRunner, runOrderIntake, type LlmPort, type PreparedDocument } from "@ai-erp/core";
import type { PgCoreStore } from "@ai-erp/db";
import { prepareDocument, type ObjectStore } from "@ai-erp/platform";
import { schema } from "@ai-erp/db";
import { eq } from "drizzle-orm";
import type { Db } from "@ai-erp/db";

export const IntakeJob = z.object({
  tenantId: z.uuid(),
  eventId: z.uuid(),
  documentIds: z.array(z.uuid()),
  senderEmail: z.string().nullable(),
  runId: z.uuid(),
});
export type IntakeJob = z.infer<typeof IntakeJob>;

export interface IntakeJobDeps {
  db: Db;
  root: PgCoreStore;
  objects: ObjectStore;
  llm: LlmPort;
  globalPause: () => boolean;
}

/**
 * One intake run: load documents, execute the pipeline as the tenant's intake agent,
 * persist the run status. Re-running the same job replays completed steps.
 */
export async function handleIntakeJob(deps: IntakeJobDeps, raw: unknown): Promise<void> {
  const job = IntakeJob.parse(raw);
  const store = deps.root.forTenant(job.tenantId);
  const tenant = await store.getTenant(job.tenantId);
  if (!tenant) throw new Error(`unknown tenant ${job.tenantId}`);
  const agentId = tenant.settings["intakeAgentPrincipalId"];
  if (typeof agentId !== "string") throw new Error(`tenant ${tenant.slug} has no intakeAgentPrincipalId`);
  const principal = await store.getPrincipal(agentId);
  if (!principal) throw new Error(`intake agent ${agentId} not found`);

  const documents: PreparedDocument[] = [];
  await store.transaction(job.tenantId, async () => {
    for (const id of job.documentIds) {
      const rows = await deps.db.select().from(schema.documents).where(eq(schema.documents.id, id)).limit(1);
      const d = rows[0];
      if (!d) continue;
      const obj = await deps.objects.get(d.storageKey);
      if (!obj) continue;
      documents.push(prepareDocument({ id: d.id, kind: d.kind as PreparedDocument["kind"], filename: d.filename, fromAddress: d.fromAddress, mime: d.mime, bytes: obj.bytes }));
    }
  });

  await store.insertAgentRun({ id: job.runId, principalId: principal.id, triggerEventId: job.eventId, workflow: "order_intake", status: "running" }).catch(() => undefined);
  const killCheck = async (): Promise<string | null> => {
    if (deps.globalPause()) return "global pause";
    const t = await store.getTenant(job.tenantId);
    if (t?.agentsPausedAt) return "tenant paused";
    const p = await store.getPrincipal(principal.id);
    if (p?.policy?.killedAt) return "agent killed";
    return null;
  };
  const steps = createStepRunner({ store, runId: job.runId, killCheck });

  try {
    const out = await runOrderIntake({ registry: createDefaultRegistry(), store, llm: deps.llm, tenant, principal, steps, globalPause: deps.globalPause() }, { documents, senderEmail: job.senderEmail });
    await store.updateAgentRunStatus(job.runId, out.kind === "noop" ? "completed_noop" : out.status === "checks_failed" ? "checks_failed" : out.status === "auto_approved" ? "auto_approved" : "pending_approval");
  } catch (err) {
    if (err instanceof RunKilledError) {
      await store.updateAgentRunStatus(job.runId, "killed", err.reason);
      return;
    }
    await store.updateAgentRunStatus(job.runId, "failed", err instanceof Error ? err.message : String(err));
    throw err;
  }
}
