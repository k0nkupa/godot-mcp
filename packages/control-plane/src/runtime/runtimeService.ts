import { randomUUID } from "node:crypto";

import type {
  InputOperationInput,
  InputOperationResult,
  ProjectIdentity,
  RuntimeCaptureFrameMetadata,
  RuntimeCaptureInput,
  RuntimeHandle,
  RuntimeOperationInput,
} from "@godot-mcp/protocol";
import { InputOperationResultSchema } from "@godot-mcp/protocol";

import { GodotMcpException } from "../errors.js";
import {
  createRuntimeDescriptor,
  type RuntimeDescriptorInput,
  type RuntimeDescriptorMaterial,
} from "./runtimeDescriptor.js";
import {
  assertLoopbackListenerOwnedByProcess,
  OwnedGodotProcess,
  type OwnedRuntimeProcess,
} from "./runtimeProcess.js";
import { inputTraceEvents, traceSha256 } from "./inputReceipt.js";

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
  prepare(input: { descriptor: RuntimeDescriptorMaterial["descriptor"] }): Promise<{ debugPort: number; editorPid?: number }>;
  verifyDebuggerListener?(pid: number, port: number): Promise<void>;
  launchProcess?(input: RuntimeProcessLaunchInput): Promise<OwnedRuntimeProcess>;
  command(operation: string, input: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  capture?(input: Record<string, unknown>, timeoutMs?: number): Promise<{
    data: RuntimeCaptureFrameMetadata;
    binary?: Uint8Array;
    binarySha256?: string;
  }>;
  cleanup?(): Promise<void>;
}

export interface RuntimeSnapshot {
  state: RuntimeState;
  handle: RuntimeHandle | null;
  scenePath: string | null;
  process: { pid: number; fingerprint: string } | null;
}

type LaunchInput = Extract<RuntimeOperationInput, { operation: "launch" }>;

function runtimeError(code: "NOT_ATTACHED" | "AUTHENTICATION_FAILED" | "CONFLICT" | "STALE_HANDLE" | "PRECONDITION_FAILED" | "GODOT_RUNTIME_ERROR", message: string, retryable = false): GodotMcpException {
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
  private disconnectPromise: Promise<void> | undefined;
  private launchPromise: Promise<{ handle: RuntimeHandle; root: unknown }> | undefined;
  private cleanupPromise: Promise<void> | undefined;
  private debuggerCleaned = true;
  private lifecycleEpoch = 0;
  private closed = false;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: RuntimeServiceDependencies) {}

  snapshot(): RuntimeSnapshot {
    return {
      state: this.state,
      handle: this.handle ? { ...this.handle } : null,
      scenePath: this.scenePath,
      process: this.process ? { pid: this.process.pid, fingerprint: this.process.fingerprint } : null,
    };
  }

  launch(input: Omit<LaunchInput, "operation">): Promise<{ handle: RuntimeHandle; root: unknown }> {
    if (this.closed) return Promise.reject(runtimeError("CONFLICT", "Runtime service is closed"));
    if (this.disconnectPromise) return Promise.reject(runtimeError("CONFLICT", "Runtime service is disconnecting"));
    if (this.launchPromise) return Promise.reject(runtimeError("CONFLICT", "A runtime launch is already in progress"));
    if (!["idle", "stopped"].includes(this.state)) return Promise.reject(runtimeError("CONFLICT", "A runtime is already active"));
    const epoch = this.lifecycleEpoch;
    const activeLaunch = this.launchGeneration(input, epoch).finally(() => {
      if (this.launchPromise === activeLaunch) this.launchPromise = undefined;
    });
    this.launchPromise = activeLaunch;
    return activeLaunch;
  }

  private async launchGeneration(input: Omit<LaunchInput, "operation">, epoch: number): Promise<{ handle: RuntimeHandle; root: unknown }> {
    const sessionId = this.dependencies.sessionId();
    if (!sessionId) throw runtimeError("NOT_ATTACHED", "Godot editor addon is not attached", true);
    this.generation += 1;
    this.handle = { runId: randomUUID(), generation: this.generation };
    this.scenePath = input.scenePath;
    this.processStopped = false;
    try {
      await this.cleanupDebugger(true);
      this.assertLaunchCurrent(epoch);
      this.state = "preparing";
      const descriptorInput: RuntimeDescriptorInput = {
        project: this.dependencies.project,
        sessionId,
        runId: this.handle.runId,
        generation: this.handle.generation,
        scenePath: input.scenePath,
      };
      this.descriptor = await (this.dependencies.createDescriptor ?? createRuntimeDescriptor)(descriptorInput);
      const descriptor = this.descriptor;
      this.assertLaunchCurrent(epoch);
      this.debuggerCleaned = false;
      const prepared = await this.dependencies.prepare({ descriptor: descriptor.descriptor });
      this.assertLaunchCurrent(epoch);
      if (!Number.isInteger(prepared.debugPort) || prepared.debugPort < 1 || prepared.debugPort > 65_535) {
        throw runtimeError("GODOT_RUNTIME_ERROR", "Editor reported an invalid debugger port");
      }
      if (prepared.editorPid !== undefined) {
        if (!Number.isInteger(prepared.editorPid) || prepared.editorPid < 1) {
          throw runtimeError("GODOT_RUNTIME_ERROR", "Editor reported an invalid process identity");
        }
        await (this.dependencies.verifyDebuggerListener ?? assertLoopbackListenerOwnedByProcess)(prepared.editorPid, prepared.debugPort);
        this.assertLaunchCurrent(epoch);
      }
      this.state = "launching";
      const launch = this.dependencies.launchProcess ?? ((launchInput) => OwnedGodotProcess.launch(launchInput));
      this.process = await launch({
        godotBin: this.dependencies.godotBin ?? process.env.GODOT_BIN ?? "godot",
        projectRoot: this.dependencies.project.rootRealPath,
        debugPort: prepared.debugPort,
        descriptorPath: descriptor.path,
      });
      this.assertLaunchCurrent(epoch);
      const ownedProcess = this.process;
      void ownedProcess.wait().then(
        () => this.onProcessExit(ownedProcess),
        () => this.onProcessExit(ownedProcess),
      );
      this.state = "authenticating";
      const ready = await this.dependencies.command("await_ready", { handle: this.handle }, input.startupTimeoutMs);
      this.assertLaunchCurrent(epoch);
      if (
        typeof ready !== "object" ||
        ready === null ||
        !("pid" in ready) ||
        Number((ready as { pid: unknown }).pid) !== this.process.pid
      ) {
        throw runtimeError("AUTHENTICATION_FAILED", "Authenticated runtime PID does not match the owned process");
      }
      await descriptor.consume?.();
      this.assertLaunchCurrent(epoch);
      if (this.processStopped) {
        throw runtimeError("GODOT_RUNTIME_ERROR", "Owned runtime exited before launch completed");
      }
      this.state = "running";
      return { handle: { ...this.handle }, root: ready };
    } catch (error) {
      this.state = "failed";
      await this.cleanup();
      throw error;
    }
  }

  execute(input: Exclude<RuntimeOperationInput, LaunchInput>): Promise<unknown> {
    return this.runExclusive(() => this.executeExclusive(input));
  }

  private async executeExclusive(input: Exclude<RuntimeOperationInput, LaunchInput>): Promise<unknown> {
    if (input.operation === "status") {
      if (input.handle) this.assertHandleIdentity(input.handle);
      if (!this.handle || !["running", "paused"].includes(this.state)) return this.snapshot();
      const runtimeStatus = await this.dependencies.command("status", { handle: this.handle });
      if (typeof runtimeStatus !== "object" || runtimeStatus === null) return this.snapshot();
      if ("paused" in runtimeStatus && typeof runtimeStatus.paused === "boolean") {
        this.state = runtimeStatus.paused ? "paused" : "running";
      }
      return { ...this.snapshot(), ...runtimeStatus };
    }
    this.assertHandle(input.handle);
    if (input.operation === "stop") {
      this.state = "stopping";
      let stopError: unknown;
      try {
        await this.dependencies.command("stop", { ...input });
      } catch (error) {
        stopError = error;
      }
      try {
        await this.cleanup();
      } catch (error) {
        this.state = "failed";
        throw error;
      }
      if (stopError) throw stopError;
      return this.snapshot();
    }
    const timeoutMs = input.operation === "wait" ? input.timeoutMs + 1_000 : undefined;
    const result = await this.dependencies.command(input.operation, { ...input }, timeoutMs);
    if (input.operation === "pause") this.state = "paused";
    if (input.operation === "resume") this.state = "running";
    return result;
  }

  capture(input: RuntimeCaptureInput): Promise<{
    frames: Array<{ data: Uint8Array; metadata: RuntimeCaptureFrameMetadata }>;
  }> {
    return this.runExclusive(() => this.captureExclusive(input));
  }

  input(input: InputOperationInput): Promise<InputOperationResult> {
    return this.runExclusive(() => this.inputExclusive(input));
  }

  private async inputExclusive(input: InputOperationInput): Promise<InputOperationResult> {
    this.assertHandle(input.handle);
    if ((input.operation === "replay" || (input.operation === "sequence" && input.mode === "deterministic")) && this.state !== "paused") {
      throw runtimeError("PRECONDITION_FAILED", "Deterministic input requires a paused runtime");
    }
    if (input.operation === "sequence" && input.mode === "realtime" && this.state !== "running") {
      throw runtimeError("PRECONDITION_FAILED", "Realtime input requires a running runtime");
    }
    const timeoutMs = input.operation === "sequence" || input.operation === "replay"
      ? input.timeoutMs + 1_000
      : undefined;
    const raw = await this.dependencies.command("input", { handle: input.handle, input }, timeoutMs);
    const result = InputOperationResultSchema.parse(raw);
    if (
      result.receipt.handle.runId !== input.handle.runId ||
      result.receipt.handle.generation !== input.handle.generation ||
      result.receipt.operation !== input.operation
    ) throw runtimeError("GODOT_RUNTIME_ERROR", "Runtime input receipt identity does not match the request");
    if (input.operation !== "record_stop") {
      const events = inputTraceEvents(input);
      const expectedDeterministic = input.operation === "replay" || (input.operation === "sequence" && input.mode === "deterministic");
      if (
        result.receipt.eventCount !== events.length ||
        result.receipt.deliveredCount !== events.length ||
        result.receipt.events.length !== events.length ||
        result.receipt.deterministic !== expectedDeterministic ||
        result.receipt.traceSha256 !== traceSha256({ schemaVersion: 1, events })
      ) throw runtimeError("GODOT_RUNTIME_ERROR", "Runtime input receipt does not match the requested trace");
    }
    return result;
  }

  private async captureExclusive(input: RuntimeCaptureInput): Promise<{
    frames: Array<{ data: Uint8Array; metadata: RuntimeCaptureFrameMetadata }>;
  }> {
    this.assertHandle(input.handle);
    if (!this.dependencies.capture) throw runtimeError("GODOT_RUNTIME_ERROR", "Runtime capture transport is unavailable");
    const frames = [];
    for (let frameIndex = 0; frameIndex < input.frameCount; frameIndex += 1) {
      const response = await this.dependencies.capture({
        operation: "capture",
        handle: input.handle,
        maxWidth: input.maxWidth,
        maxHeight: input.maxHeight,
        frameIndex,
        waitFrames: frameIndex === 0 ? 0 : input.intervalFrames,
        advancePaused: input.advancePaused,
      }, 15_000);
      if (!response.binary || response.binarySha256 !== response.data.sha256) {
        throw runtimeError("GODOT_RUNTIME_ERROR", "Runtime capture omitted verified PNG bytes");
      }
      frames.push({ data: response.binary, metadata: response.data });
    }
    return { frames };
  }

  close(): Promise<void> {
    this.closed = true;
    if (!this.closePromise) {
      const activeClose = this.disconnect();
      this.closePromise = activeClose;
      void activeClose.catch(() => {
        if (this.closePromise === activeClose) this.closePromise = undefined;
      });
    }
    return this.closePromise;
  }

  disconnect(): Promise<void> {
    if (this.disconnectPromise) return this.disconnectPromise;
    this.lifecycleEpoch += 1;
    const activeDisconnect = (async () => {
      await this.launchPromise?.catch(() => undefined);
      await this.runExclusive(() => this.cleanup());
    })();
    this.disconnectPromise = activeDisconnect;
    void activeDisconnect.finally(() => {
      if (this.disconnectPromise === activeDisconnect) this.disconnectPromise = undefined;
    }).catch(() => undefined);
    return activeDisconnect;
  }

  private assertHandle(handle: RuntimeHandle): void {
    this.assertHandleIdentity(handle);
    if (!["running", "paused"].includes(this.state)) throw runtimeError("CONFLICT", "Runtime is not controllable in its current state");
  }

  private assertHandleIdentity(handle: RuntimeHandle): void {
    if (!this.handle || handle.runId !== this.handle.runId || handle.generation !== this.handle.generation) {
      throw runtimeError("STALE_HANDLE", "Runtime handle is stale");
    }
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private assertLaunchCurrent(epoch: number): void {
    if (this.closed || epoch !== this.lifecycleEpoch) {
      throw runtimeError("CONFLICT", "Runtime launch was cancelled by shutdown");
    }
  }

  private async stopProcess(): Promise<void> {
    if (!this.process || this.processStopped) return;
    const ownedProcess = this.process;
    this.processStopped = true;
    try {
      await ownedProcess.stop();
    } catch (error) {
      if (this.process === ownedProcess) this.processStopped = false;
      throw error;
    }
  }

  private async cleanup(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    const activeCleanup = (async () => {
      let cleanupError: unknown;
      if (this.descriptor) {
        try {
          await this.descriptor.cleanup();
          this.descriptor = null;
        } catch (error) {
          cleanupError = error;
        }
      }
      await this.cleanupDebugger(false);
      try {
        await this.stopProcess();
      } catch (error) {
        cleanupError ??= error;
      }
      if (cleanupError) {
        this.state = "failed";
        throw cleanupError;
      }
      if (!["stopped", "idle"].includes(this.state)) this.state = "stopped";
    })();
    this.cleanupPromise = activeCleanup;
    try {
      await activeCleanup;
    } finally {
      if (this.cleanupPromise === activeCleanup) this.cleanupPromise = undefined;
    }
  }

  private async cleanupDebugger(required: boolean): Promise<void> {
    if (this.debuggerCleaned) return;
    if (!this.dependencies.cleanup) {
      this.debuggerCleaned = true;
      return;
    }
    try {
      await this.dependencies.cleanup();
      this.debuggerCleaned = true;
    } catch (error) {
      if (required) throw error;
    }
  }

  private onProcessExit(process: OwnedRuntimeProcess): void {
    if (this.process !== process || this.processStopped) return;
    this.processStopped = true;
    void this.runExclusive(() => this.cleanup()).catch(() => undefined);
  }
}
