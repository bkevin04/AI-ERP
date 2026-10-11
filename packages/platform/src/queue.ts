export interface JobQueue {
  enqueue(name: string, data: Record<string, unknown>, opts?: { singletonKey?: string }): Promise<string | null>;
}

export class MemoryJobQueue implements JobQueue {
  readonly jobs: Array<{ name: string; data: Record<string, unknown>; singletonKey?: string }> = [];
  async enqueue(name: string, data: Record<string, unknown>, opts?: { singletonKey?: string }) {
    if (opts?.singletonKey && this.jobs.some((j) => j.name === name && j.singletonKey === opts.singletonKey)) return null;
    this.jobs.push({ name, data, singletonKey: opts?.singletonKey });
    return String(this.jobs.length);
  }
}

/** Job names shared by the API (producer) and the worker (consumer). */
export const JOBS = {
  intakeRun: "intake.run",
  syncMasterData: "sync.master-data",
  writeback: "writeback.push",
  reconcile: "reconcile",
} as const;
