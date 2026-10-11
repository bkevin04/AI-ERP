export type ToolErrorCode =
  | "not_found"
  | "forbidden"
  | "killed"
  | "rate_limited"
  | "invalid_input"
  | "invalid_output"
  | "idempotency_key_required"
  | "idempotency_conflict"
  | "conflict"
  | "internal";

export class ToolError extends Error {
  constructor(
    public readonly code: ToolErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ToolError";
  }

  get httpStatus(): number {
    switch (this.code) {
      case "not_found":
        return 404;
      case "forbidden":
      case "killed":
        return 403;
      case "rate_limited":
        return 429;
      case "invalid_input":
      case "idempotency_key_required":
        return 400;
      case "idempotency_conflict":
      case "conflict":
        return 409;
      case "invalid_output":
      case "internal":
        return 500;
    }
  }
}

export class RunKilledError extends Error {
  constructor(public readonly runId: string, public readonly reason: string) {
    super(`run ${runId} killed: ${reason}`);
    this.name = "RunKilledError";
  }
}
