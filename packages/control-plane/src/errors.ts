import { GodotMcpErrorSchema, type GodotMcpError } from "@godot-mcp/protocol";

export class GodotMcpException extends Error {
  readonly code: GodotMcpError["code"];
  readonly retryable: boolean;
  readonly correlationId: string;
  readonly partialEffects: boolean;
  readonly rollback: GodotMcpError["rollback"];
  readonly failedPhase: string;
  readonly safeRecovery: string;

  constructor(input: Omit<GodotMcpError, "failedPhase" | "safeRecovery"> & Partial<Pick<GodotMcpError, "failedPhase" | "safeRecovery">>) {
    const error = GodotMcpErrorSchema.parse(input);
    super(error.message);
    this.name = "GodotMcpException";
    this.code = error.code;
    this.retryable = error.retryable;
    this.correlationId = error.correlationId;
    this.partialEffects = error.partialEffects;
    this.rollback = error.rollback;
    this.failedPhase = error.failedPhase;
    this.safeRecovery = error.safeRecovery;
  }
}
