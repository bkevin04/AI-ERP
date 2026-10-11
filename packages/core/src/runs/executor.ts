import type { StepKind } from "@ai-erp/contracts";
import { RunKilledError } from "../errors.js";
import type { CoreStore } from "../store.js";
import type { RunContext } from "../tools/context.js";
import { hashJson, newId } from "../util.js";

export interface StepRunner {
  /**
   * Execute `fn` once per (run, seq, name, input). On a retry after a crash the stored
   * output is returned instead of re-executing, so model calls are never re-sampled.
   */
  step<T>(name: string, kind: StepKind, input: unknown, fn: () => Promise<T>): Promise<T>;
  readonly run: RunContext;
}

export interface ExecutorOptions {
  store: CoreStore;
  runId: string;
  /** Returns a reason string when the run must stop, null to continue. Checked before every step. */
  killCheck?: () => Promise<string | null>;
  /** Steps already recorded for this run, highest seq first is fine; used to seed the counter. */
  resumeFromSeq?: number;
}

export function createStepRunner(opts: ExecutorOptions): StepRunner {
  let seq = opts.resumeFromSeq ?? 0;
  const run: RunContext = { id: opts.runId, nextSeq: () => ++seq };

  return {
    run,
    async step<T>(name: string, kind: StepKind, input: unknown, fn: () => Promise<T>): Promise<T> {
      const reason = opts.killCheck ? await opts.killCheck() : null;
      if (reason) throw new RunKilledError(opts.runId, reason);

      const mySeq = run.nextSeq();
      const key = hashJson({ runId: opts.runId, seq: mySeq, name, input });
      const prior = await opts.store.findRunStep(opts.runId, key);
      if (prior && prior.status === "ok") return prior.output as T;

      const started = Date.now();
      try {
        const output = await fn();
        await opts.store.insertRunStep({
          id: newId(), runId: opts.runId, seq: mySeq, kind, name, input, output,
          idempotencyKey: key, status: "ok", durationMs: Date.now() - started,
        });
        return output;
      } catch (err) {
        await opts.store.insertRunStep({
          id: newId(), runId: opts.runId, seq: mySeq, kind, name, input,
          output: { error: err instanceof Error ? err.message : String(err) },
          idempotencyKey: `${key}:err:${Date.now()}`, status: "error", durationMs: Date.now() - started,
        });
        throw err;
      }
    },
  };
}
