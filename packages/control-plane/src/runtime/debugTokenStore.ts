import { randomBytes } from "node:crypto";

export interface DebugTokenIdentity {
  runId: string;
  generation: number;
  dapGeneration: number;
  stopSequence: number;
}

interface VariableRecord {
  variablesReference: number;
  depth: number;
}

export class DebugTokenStoreError extends Error {
  readonly code = "STALE_HANDLE";

  constructor(message: string) {
    super(message);
    this.name = "DebugTokenStoreError";
  }
}

export class DebugTokenStore {
  private identity: DebugTokenIdentity | null = null;
  private readonly frames = new Map<string, number>();
  private readonly frameReferences = new Map<number, string>();
  private readonly variables = new Map<string, VariableRecord>();
  private readonly maxFrames: number;
  private readonly maxVariables: number;
  private readonly maxDepth: number;
  private variableEntries = 0;

  constructor(options: { maxFrames?: number; maxVariables?: number; maxDepth?: number } = {}) {
    this.maxFrames = options.maxFrames ?? 64;
    this.maxVariables = options.maxVariables ?? 2_048;
    this.maxDepth = options.maxDepth ?? 8;
  }

  bind(identity: DebugTokenIdentity): void {
    if (this.identity && sameIdentity(this.identity, identity)) return;
    this.clearRecords();
    this.identity = { ...identity };
  }

  issueFrame(frameId: number): string {
    this.assertBound();
    if (!Number.isInteger(frameId) || frameId < 0) throw new DebugTokenStoreError("DAP frame identity is invalid");
    const existing = this.frameReferences.get(frameId);
    if (existing) return existing;
    if (this.frames.size >= this.maxFrames) throw new DebugTokenStoreError("Debugger frame token limit exceeded");
    const opaqueId = this.createToken("dft", this.frames, this.variables);
    this.frames.set(opaqueId, frameId);
    this.frameReferences.set(frameId, opaqueId);
    return opaqueId;
  }

  issueVariable(variablesReference: number, depth: number): string {
    this.assertBound();
    if (!Number.isInteger(variablesReference) || variablesReference < 1) throw new DebugTokenStoreError("DAP variable reference is invalid");
    if (!Number.isInteger(depth) || depth < 1 || depth > this.maxDepth) throw new DebugTokenStoreError("Debugger variable depth limit exceeded");
    if (this.variables.size >= this.maxVariables) throw new DebugTokenStoreError("Debugger variable token limit exceeded");
    const token = this.createToken("dvt", this.frames, this.variables);
    this.variables.set(token, { variablesReference, depth });
    return token;
  }

  resolveFrame(token: string): number {
    this.assertBound();
    const frameId = this.frames.get(token);
    if (frameId === undefined) throw new DebugTokenStoreError("Debugger frame token is stale or unknown");
    return frameId;
  }

  resolveVariable(token: string): VariableRecord {
    this.assertBound();
    const record = this.variables.get(token);
    if (!record) throw new DebugTokenStoreError("Debugger variable token is stale or unknown");
    return { ...record };
  }

  consumeVariableEntries(count: number): void {
    this.assertBound();
    if (!Number.isInteger(count) || count < 0) throw new DebugTokenStoreError("Debugger variable entry count is invalid");
    if (this.variableEntries + count > this.maxVariables) throw new DebugTokenStoreError("Debugger variable entry limit exceeded");
    this.variableEntries += count;
  }

  clear(): void {
    this.identity = null;
    this.clearRecords();
  }

  private clearRecords(): void {
    this.frames.clear();
    this.frameReferences.clear();
    this.variables.clear();
    this.variableEntries = 0;
  }

  private assertBound(): void {
    if (!this.identity) throw new DebugTokenStoreError("Debugger tokens are not bound to a stopped runtime");
  }

  private createToken(prefix: "dft" | "dvt", ...stores: Array<Map<string, unknown>>): string {
    for (;;) {
      const opaqueId = `${prefix}_${randomBytes(32).toString("base64url")}`;
      if (stores.every((store) => !store.has(opaqueId))) return opaqueId;
    }
  }
}

function sameIdentity(left: DebugTokenIdentity, right: DebugTokenIdentity): boolean {
  return left.runId === right.runId &&
    left.generation === right.generation &&
    left.dapGeneration === right.dapGeneration &&
    left.stopSequence === right.stopSequence;
}
