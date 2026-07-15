import { randomUUID } from "node:crypto";

import type { ProjectIdentity, RuntimeHandle, RuntimeOperationInput } from "@godot-mcp/protocol";

import { GodotMcpException } from "../errors.js";
import {
  createRuntimeDescriptor,
  type RuntimeDescriptorInput,
  type RuntimeDescriptorMaterial,
} from "./runtimeDescriptor.js";
import { OwnedGodotProcess, type OwnedRuntimeProcess } from "./runtimeProcess.js";

export type RuntimeState = "idle" | "preparing" | "launching" | "authenticating" | "running" | "paused" | "stopping" | "stopped" | "failed";

interface RuntimeProcessLaunchInput {
  godotBin: string;
  projectRoot: string;
  debugPort: number;
  descriptorPath: string;
}

export interface RuntimeServiceDependencies {
  project: ProjectIdentity;
  sessionId(): string | null;
  godotBin?: string;
  createDescriptor?(input: RuntimeDescriptorInput): Promise<RuntimeDescriptorMaterial>;
  prepare(input: { descriptor: RuntimeDescriptorMaterial["descriptor"] }): Promise<{ debugPort: number }>;
  launchProcess?(input: RuntimeProcessLaunchInput): Promise<OwnedRuntimeProcess>;
  command(operation: string, input: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

export interface RuntimeSnapshot {
  state: RuntimeState;
  handle: RuntimeHandle | null;
  scenePath: string | null;
  process: { pid: number; fingerprint: string } | null;
}

type LaunchInput = Extract<RuntimeOperationInput, { operation: "launch" }>;

function runtimeError(code: "NOT_ATTACHED" | "CONFLICT" | "STALE_HANDLE" | "GODOT_RUNTIME_ERROR", message: string, retryable = false): GodotMcpException {
  return new GodotMcpException({
    code,
    message,
    retryable,
    correlationId: randomUUID(),
    partialEffects: false,
    rollback: "not_needed",
  });
}

export class RuntimeService {
  private state: RuntimeState = "idle";
  private generation = 0;
  private handle: RuntimeHandle | null = null;
  private scenePath: string | null = null;
  private process: OwnedRuntimeProcess | null = null;
  private processStopped = false;
  private descriptor: RuntimeDescriptorMaterial | null = null;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly dependencies: RuntimeServiceDependencies) {}

  snapshot(): RuntimeSnapshot {
    return {
      state: this.state,
      handle: this.handle ? { ...this.handle } : null,
      scenePath: this.scenePath,
      process: this.process ? { pid: this.process.pid, fingerprint: this.process.fingerprint } : null,
    };
  }

  async launch(input: Omit<LaunchInput, "operation">): Promise<{ handle: RuntimeHandle; root: unknown }> {
    if (!["idle", "stopped"].includes(this.state)) throw runtimeError("CONFLICT", "A runtime is already active");
    const sessionId = this.dependencies.sessionId();
    if (!sessionId) throw runtimeError("NOT_ATTACHED", "Godot editor addon is not attached", true);
    this.generation += 1;
    this.handle = { runId: randomUUID(), generation: this.generation };
    this.scenePath = input.scenePath;
    this.processStopped = false;
    try {
      this.state = "preparing";
      const descriptorInput: RuntimeDescriptorInput = {
        project: this.dependencies.project,
        sessionId,
        runId: this.handle.runId,
        generation: this.handle.generation,
        scenePath: input.scenePath,
      };
      this.descriptor = await (this.dependencies.createDescriptor ?? createRuntimeDescriptor)(descriptorInput);
      const prepared = await this.dependencies.prepare({ descriptor: this.descriptor.descriptor });
      if (!Number.isInteger(prepared.debugPort) || prepared.debugPort < 1 || prepared.debugPort > 65_535) {
        throw runtimeError("GODOT_RUNTIME_ERROR", "Editor reported an invalid debugger port");
      }
      this.state = "launching";
      const launch = this.dependencies.launchProcess ?? ((launchInput) => OwnedGodotProcess.launch(launchInput));
      this.process = await launch({
        godotBin: this.dependencies.godotBin ?? process.env.GODOT_BIN ?? "/opt/homebrew/bin/godot",
        projectRoot: this.dependencies.project.rootRealPath,
        debugPort: prepared.debugPort,
        descriptorPath: this.descriptor.path,
      });
      this.state = "authenticating";
      const ready = await this.dependencies.command("await_ready", { handle: this.handle }, input.startupTimeoutMs);
      await this.descriptor.cleanup();
      this.descriptor = null;
      this.state = "running";
      return { handle: { ...this.handle }, root: ready };
    } catch (error) {
      this.state = "failed";
      await this.cleanup();
      throw error;
    }
  }

  async execute(input: Exclude<RuntimeOperationInput, LaunchInput>): Promise<unknown> {
    if (input.operation === "status") return this.snapshot();
    this.assertHandle(input.handle);
    if (input.operation === "stop") {
      this.state = "stopping";
      await this.dependencies.command("stop", { ...input });
      await this.stopProcess();
      this.state = "stopped";
      return this.snapshot();
    }
    const result = await this.dependencies.command(input.operation, { ...input });
    if (input.operation === "pause") this.state = "paused";
    if (input.operation === "resume") this.state = "running";
    return result;
  }

  close(): Promise<void> {
    this.closePromise ??= this.cleanup();
    return this.closePromise;
  }

  private assertHandle(handle: RuntimeHandle): void {
    if (!this.handle || handle.runId !== this.handle.runId || handle.generation !== this.handle.generation) {
      throw runtimeError("STALE_HANDLE", "Runtime handle is stale");
    }
    if (!["running", "paused"].includes(this.state)) throw runtimeError("CONFLICT", "Runtime is not controllable in its current state");
  }

  private async stopProcess(): Promise<void> {
    if (!this.process || this.processStopped) return;
    await this.process.stop();
    this.processStopped = true;
  }

  private async cleanup(): Promise<void> {
    await this.descriptor?.cleanup().catch(() => undefined);
    this.descriptor = null;
    await this.stopProcess();
    if (!["stopped", "idle"].includes(this.state)) this.state = "stopped";
  }
}
