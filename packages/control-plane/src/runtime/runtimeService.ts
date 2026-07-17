import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import type {
  InputOperationInput,
  InputOperationResult,
  ProjectIdentity,
  DebugStopResult,
  RuntimeCaptureFrameMetadata,
  RuntimeCaptureInput,
  RuntimeDebugOperationInput,
  RuntimeHandle,
  RuntimeOperationInput,
  RuntimePerformanceOperationInput,
} from "@godot-mcp/protocol";
import { DebugStopResultSchema, InputOperationResultSchema, MonitorSnapshotSchema, ProfileJobReceiptSchema, ProfileResultSchema } from "@godot-mcp/protocol";

import { GodotMcpException } from "../errors.js";
import { resolveProjectPath } from "../project/pathPolicy.js";
import { DebuggerClientError, type DebuggerCommand, type DebuggerStopEvent } from "./debuggerClient.js";
import { DebugTokenStore, DebugTokenStoreError } from "./debugTokenStore.js";
import {
  createRuntimeDescriptor,
  type RuntimeDescriptorInput,
  type RuntimeDescriptorMaterial,
} from "./runtimeDescriptor.js";
import {
  assertLoopbackListenerOwnedByProcess,
  assertLoopbackListenersOwnedByProcess,
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
  requireAuthenticatedDebuggerMetadata?: boolean;
  createDescriptor?(input: RuntimeDescriptorInput): Promise<RuntimeDescriptorMaterial>;
  prepare(input: { descriptor: RuntimeDescriptorMaterial["descriptor"] }): Promise<{ debugPort: number; editorPid?: number; debugTransport?: string }>;
  verifyDebuggerListener?(pid: number, port: number): Promise<void>;
  verifyEditorListener?(pid: number, port: number): Promise<void>;
  launchProcess?(input: RuntimeProcessLaunchInput): Promise<OwnedRuntimeProcess>;
  command(operation: string, input: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  capture?(input: Record<string, unknown>, timeoutMs?: number): Promise<{
    data: RuntimeCaptureFrameMetadata;
    binary?: Uint8Array;
    binarySha256?: string;
  }>;
  cleanup?(): Promise<void>;
}

export interface RuntimeDebuggerClient {
  request(command: DebuggerCommand, argumentsValue: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
  nextStop(afterSequence: number, timeoutMs: number): Promise<DebuggerStopEvent>;
  snapshot(): { connected: boolean; stopped: boolean; stopSequence: number };
  markRunning(afterSequence?: number): void;
  refresh?(): Promise<void>;
  close(): Promise<void>;
}

class AuthenticatedDebuggerClient implements RuntimeDebuggerClient {
  private connected = true;
  private stopped = false;
  private stopSequence = 0;

  constructor(
    private readonly command: RuntimeServiceDependencies["command"],
    private readonly handle: RuntimeHandle,
  ) {}

  async request(command: DebuggerCommand, adapterArguments: Record<string, unknown>, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    if (!this.connected) throw runtimeError("TRANSPORT_ERROR", "Authenticated debugger channel is closed", true);
    const response = await this.command("debug_adapter", { handle: this.handle, command, adapterArguments }, timeoutMs);
    if (!isRecord(response)) throw runtimeError("GODOT_RUNTIME_ERROR", "Authenticated debugger returned a malformed response");
    if (command === "pause") {
      const body = isRecord(response.body) ? response.body : {};
      this.stopped = true;
      this.stopSequence = Math.max(this.stopSequence, integerOr(body.sequence, this.stopSequence + 1));
    } else if (command === "continue" || command === "next" || command === "stepIn") {
      this.stopped = false;
    }
    await this.refresh();
    return response;
  }

  async nextStop(afterSequence: number, timeoutMs: number): Promise<DebuggerStopEvent> {
    const response = await this.command("debug_adapter", {
      handle: this.handle,
      command: "wait",
      adapterArguments: { afterSequence, timeoutMs },
    }, timeoutMs + 250);
    if (!isRecord(response) || !Number.isInteger(response.sequence) || typeof response.reason !== "string") {
      throw runtimeError("GODOT_RUNTIME_ERROR", "Authenticated debugger returned a malformed stop event");
    }
    this.stopped = true;
    this.stopSequence = Number(response.sequence);
    return { sequence: this.stopSequence, reason: response.reason, body: { reason: response.reason, threadId: 1 } };
  }

  snapshot() {
    return { connected: this.connected, stopped: this.stopped, stopSequence: this.stopSequence };
  }

  markRunning(afterSequence = this.stopSequence): void {
    if (this.stopSequence <= afterSequence) this.stopped = false;
  }

  async refresh(): Promise<void> {
    if (!this.connected) return;
    const response = await this.command("debug_adapter", {
      handle: this.handle,
      command: "status",
      adapterArguments: {},
    });
    if (!isRecord(response) || typeof response.connected !== "boolean" || typeof response.stopped !== "boolean" || !Number.isInteger(response.stopSequence)) {
      throw runtimeError("GODOT_RUNTIME_ERROR", "Authenticated debugger returned malformed status");
    }
    this.connected = response.connected;
    this.stopped = response.stopped;
    this.stopSequence = Number(response.stopSequence);
  }

  async close(): Promise<void> {
    this.connected = false;
  }
}

export interface RuntimeSnapshot {
  state: RuntimeState;
  handle: RuntimeHandle | null;
  scenePath: string | null;
  process: { pid: number; fingerprint: string } | null;
}

type LaunchInput = Extract<RuntimeOperationInput, { operation: "launch" }>;

function runtimeError(code: "NOT_ATTACHED" | "AUTHENTICATION_FAILED" | "CONFLICT" | "STALE_HANDLE" | "PRECONDITION_FAILED" | "INVALID_REQUEST" | "TIMEOUT" | "TRANSPORT_ERROR" | "GODOT_RUNTIME_ERROR", message: string, retryable = false): GodotMcpException {
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
  private debuggerClient: RuntimeDebuggerClient | null = null;
  private debuggerGeneration = 0;
  private debuggerSessionId: number | null = null;
  private readonly debugTokens = new DebugTokenStore();
  private readonly breakpointSources = new Map<string, number[]>();
  private opaqueProfileId: string | null = null;

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
      if (this.dependencies.requireAuthenticatedDebuggerMetadata && (prepared.editorPid === undefined || prepared.debugTransport !== "authenticated-editor-session")) {
        throw runtimeError("AUTHENTICATION_FAILED", "Authenticated editor debugger transport and process identity are required for runtime debugging");
      }
      if (prepared.editorPid !== undefined) {
        if (!Number.isInteger(prepared.editorPid) || prepared.editorPid < 1) {
          throw runtimeError("GODOT_RUNTIME_ERROR", "Editor reported an invalid process identity");
        }
        const verifyListener = this.dependencies.verifyEditorListener ?? this.dependencies.verifyDebuggerListener ?? assertLoopbackListenerOwnedByProcess;
        await assertLoopbackListenersOwnedByProcess(
          prepared.editorPid,
          [prepared.debugPort],
          verifyListener,
        );
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
      const readySessionId = Number((ready as { debuggerSessionId?: unknown }).debuggerSessionId);
      if (this.dependencies.requireAuthenticatedDebuggerMetadata && (!Number.isInteger(readySessionId) || readySessionId < 0)) {
        throw runtimeError("AUTHENTICATION_FAILED", "Authenticated runtime omitted its debugger session identity");
      }
      this.debuggerSessionId = Number.isInteger(readySessionId) && readySessionId >= 0 ? readySessionId : null;
      await descriptor.consume?.();
      this.assertLaunchCurrent(epoch);
      if (this.processStopped) {
        throw runtimeError("GODOT_RUNTIME_ERROR", "Owned runtime exited before launch completed");
      }
      if (prepared.debugTransport === "authenticated-editor-session" && this.debuggerSessionId !== null) {
        this.attachAuthenticatedDebugger();
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
    if (input.operation.startsWith("debug_")) {
      this.assertHandle((input as RuntimeDebugOperationInput).handle);
      try {
        return await this.executeDebug(input as RuntimeDebugOperationInput);
      } catch (error) {
        throw normalizeDebugError(error);
      }
    }
    if (input.operation === "monitor_snapshot" || input.operation.startsWith("profile_")) {
      this.assertHandle((input as RuntimePerformanceOperationInput).handle);
      return this.executePerformance(input as RuntimePerformanceOperationInput);
    }
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

  private async executePerformance(input: RuntimePerformanceOperationInput): Promise<unknown> {
    if (input.operation === "monitor_snapshot") {
      return MonitorSnapshotSchema.parse(await this.dependencies.command(input.operation, { ...input }));
    }
    if (input.operation === "profile_start") {
      const receipt = ProfileJobReceiptSchema.parse(await this.dependencies.command(input.operation, { ...input }));
      this.opaqueProfileId = receipt.jobToken;
      return receipt;
    }
    if (this.opaqueProfileId === null || input.jobToken !== this.opaqueProfileId) {
      throw runtimeError("STALE_HANDLE", "Profile job token is stale or unknown");
    }
    if (input.operation === "profile_result") {
      const result = ProfileResultSchema.parse(await this.dependencies.command(input.operation, { ...input }));
      if (result.evidence.jobToken !== input.jobToken) {
        throw runtimeError("STALE_HANDLE", "Profile evidence belongs to a different job");
      }
      return result;
    }
    const receipt = ProfileJobReceiptSchema.parse(await this.dependencies.command(input.operation, { ...input }));
    if (receipt.jobToken !== input.jobToken) {
      throw runtimeError("STALE_HANDLE", "Profile receipt belongs to a different job");
    }
    return receipt;
  }

  private attachAuthenticatedDebugger(): void {
    this.debuggerClient = new AuthenticatedDebuggerClient(this.dependencies.command, { ...this.handle! });
    this.debuggerGeneration += 1;
    this.debugTokens.clear();
    this.breakpointSources.clear();
  }

  private async executeDebug(input: RuntimeDebugOperationInput): Promise<unknown> {
    await this.assertDebuggerBinding();
    await this.debuggerClient?.refresh?.();
    if (input.operation === "debug_status") {
      const snapshot = this.debuggerClient?.snapshot() ?? { connected: false, stopped: false, stopSequence: 0 };
      const breakpointCount = [...this.breakpointSources.values()].reduce((total, lines) => total + lines.length, 0);
      return { ...snapshot, breakpointCount };
    }
    const debuggerClient = this.requireDebuggerClient();
    switch (input.operation) {
      case "debug_wait": {
        const stopped = await debuggerClient.nextStop(input.afterSequence, input.timeoutMs);
        this.bindDebugStop(stopped.sequence);
        return projectDebugStop(stopped);
      }
      case "debug_pause":
        if (debuggerClient.snapshot().stopped) throw runtimeError("PRECONDITION_FAILED", "Godot debugger is already stopped");
        await debuggerClient.request("pause", { threadId: 1 });
        return debuggerClient.snapshot();
      case "debug_continue":
        if (!debuggerClient.snapshot().stopped) throw runtimeError("PRECONDITION_FAILED", "Godot debugger must be stopped before continuing");
        const continueSequence = debuggerClient.snapshot().stopSequence;
        await debuggerClient.request("continue", { threadId: 1 });
        debuggerClient.markRunning(continueSequence);
        this.debugTokens.clear();
        return debuggerClient.snapshot();
      case "debug_step_over":
        return this.stepDebugger(debuggerClient, "next");
      case "debug_step_into":
        return this.stepDebugger(debuggerClient, "stepIn");
      case "debug_breakpoints_set":
        return this.setDebugBreakpoints(debuggerClient, input);
      case "debug_stack":
        return this.debugStack(debuggerClient, input.offset, input.limit);
      case "debug_variables": {
        this.bindDebugStop();
        const frameId = this.debugTokens.resolveFrame(input.frameToken);
        const reference = await this.scopeReference(debuggerClient, frameId, input.scope);
        return this.readVariables(debuggerClient, reference, 1, input.offset, input.limit);
      }
      case "debug_children": {
        this.bindDebugStop();
        const record = this.debugTokens.resolveVariable(input.variableToken);
        return this.readVariables(debuggerClient, record.variablesReference, record.depth + 1, input.offset, input.limit);
      }
      case "debug_watch": {
        this.bindDebugStop();
        const frameId = this.debugTokens.resolveFrame(input.frameToken);
        const watches = [];
        for (const selector of input.selectors) watches.push(await this.resolveWatch(debuggerClient, frameId, selector));
        return { watches };
      }
    }
  }

  private requireDebuggerClient(): RuntimeDebuggerClient {
    if (!this.debuggerClient || !this.debuggerClient.snapshot().connected) {
      throw runtimeError("PRECONDITION_FAILED", "The authenticated Godot debugger is unavailable for the active runtime", true);
    }
    return this.debuggerClient;
  }

  private async assertDebuggerBinding(): Promise<void> {
    if (this.debuggerSessionId === null || !this.handle) return;
    const status = await this.dependencies.command("debug_binding_status", { handle: this.handle });
    if (!isRecord(status) || status.unambiguous !== true || status.activeSessionCount !== 1 || status.debuggerSessionId !== this.debuggerSessionId) {
      this.debugTokens.clear();
      throw runtimeError("AUTHENTICATION_FAILED", "The Godot debugger target is not the uniquely authenticated runtime session");
    }
  }

  private bindDebugStop(stopSequence?: number): void {
    const debuggerClient = this.requireDebuggerClient();
    const snapshot = debuggerClient.snapshot();
    const sequence = stopSequence ?? snapshot.stopSequence;
    if (!snapshot.stopped || sequence < 1 || !this.handle) {
      throw runtimeError("PRECONDITION_FAILED", "Godot runtime is not stopped in a debuggable frame");
    }
    this.debugTokens.bind({
      runId: this.handle.runId,
      generation: this.handle.generation,
      debuggerGeneration: this.debuggerGeneration,
      stopSequence: sequence,
    });
  }

  private async stepDebugger(debuggerClient: RuntimeDebuggerClient, command: "next" | "stepIn"): Promise<DebugStopResult> {
    const snapshot = debuggerClient.snapshot();
    if (!snapshot.stopped) throw runtimeError("PRECONDITION_FAILED", "Godot debugger must be stopped before stepping");
    await debuggerClient.request(command, { threadId: 1 });
    debuggerClient.markRunning(snapshot.stopSequence);
    this.debugTokens.clear();
    const stopped = await debuggerClient.nextStop(snapshot.stopSequence, 10_000);
    this.bindDebugStop(stopped.sequence);
    return projectDebugStop(stopped);
  }

  private async setDebugBreakpoints(
    debuggerClient: RuntimeDebuggerClient,
    input: Extract<RuntimeDebugOperationInput, { operation: "debug_breakpoints_set" }>,
  ): Promise<{ breakpoints: unknown[] }> {
    const grouped = new Map<string, Array<{ sourcePath: string; line: number }>>();
    for (const breakpoint of input.breakpoints) {
      if (breakpoint.sourcePath.toLowerCase().startsWith("res://addons/godot_mcp/")) {
        throw runtimeError("INVALID_REQUEST", "Debugger breakpoints cannot target the Godot MCP addon");
      }
      const absolutePath = await realpath(await resolveProjectPath(this.dependencies.project, breakpoint.sourcePath, "read"));
      if (isPathInsideCaseInsensitive(join(this.dependencies.project.rootRealPath, "addons", "godot_mcp"), absolutePath)) {
        throw runtimeError("INVALID_REQUEST", "Debugger breakpoints cannot target the Godot MCP addon");
      }
      const entries = grouped.get(absolutePath) ?? [];
      entries.push(breakpoint);
      grouped.set(absolutePath, entries);
    }
    const previous = new Map([...this.breakpointSources].map(([path, lines]) => [path, [...lines]]));
    const sources = new Set([...previous.keys(), ...grouped.keys()]);
    const results: unknown[] = [];
    const applied: string[] = [];
    try {
      for (const absolutePath of sources) {
        const entries = grouped.get(absolutePath) ?? [];
        const response = await debuggerClient.request("setBreakpoints", {
          source: { name: absolutePath.split(sep).at(-1), path: absolutePath },
          breakpoints: entries.map((entry) => ({ line: entry.line })),
        });
        applied.push(absolutePath);
        const returned = bodyArray(response, "breakpoints");
        for (const [index, entry] of entries.entries()) {
          const raw = isRecord(returned[index]) ? returned[index] : {};
          results.push({
            sourcePath: entry.sourcePath,
            requestedLine: entry.line,
            verified: raw.verified === true,
            resolvedLine: integerOr(raw.line, entry.line),
            ...(typeof raw.message === "string" ? { message: raw.message.slice(0, 512) } : {}),
          });
        }
      }
    } catch (error) {
      let rollbackFailed = false;
      for (const absolutePath of applied.reverse()) {
        try {
          const lines = previous.get(absolutePath) ?? [];
          await debuggerClient.request("setBreakpoints", {
            source: { name: absolutePath.split(sep).at(-1), path: absolutePath },
            breakpoints: lines.map((line) => ({ line })),
          });
        } catch {
          rollbackFailed = true;
        }
      }
      if (rollbackFailed) {
        await this.cleanupDebuggerClient().catch(() => undefined);
        throw runtimeError("TRANSPORT_ERROR", "Breakpoint replacement failed and could not be rolled back", true);
      }
      throw error;
    }
    this.breakpointSources.clear();
    for (const [absolutePath, entries] of grouped) {
      if (entries.length > 0) this.breakpointSources.set(absolutePath, entries.map((entry) => entry.line));
    }
    return { breakpoints: results };
  }

  private async debugStack(debuggerClient: RuntimeDebuggerClient, offset: number, limit: number): Promise<{ frames: unknown[]; totalFrames: number }> {
    this.bindDebugStop();
    const response = await debuggerClient.request("stackTrace", { threadId: 1, startFrame: offset, levels: limit });
    const rawFrames = bodyArray(response, "stackFrames").slice(0, limit);
    const frames = rawFrames.flatMap((raw) => {
      if (!isRecord(raw) || !Number.isInteger(raw.id)) return [];
      const rawSourcePath = isRecord(raw.source) && typeof raw.source.path === "string" ? raw.source.path : undefined;
      if (rawSourcePath?.toLowerCase().startsWith("res://addons/godot_mcp/")) return [];
      const source = rawSourcePath
        ? this.projectSourcePath(rawSourcePath)
        : undefined;
      return [{
        frameToken: this.debugTokens.issueFrame(Number(raw.id)),
        name: boundedText(raw.name, "<anonymous>", 512),
        ...(source === undefined ? {} : { sourcePath: source }),
        line: integerOr(raw.line, 0),
        column: integerOr(raw.column, 0),
      }];
    });
    const body = isRecord(response.body) ? response.body : {};
    const reportedTotal = Number.isInteger(body.totalFrames) ? Number(body.totalFrames) : offset + rawFrames.length;
    const totalFrames = Math.min(64, Math.max(offset + rawFrames.length, reportedTotal));
    return { frames, totalFrames };
  }

  private async scopeReference(debuggerClient: RuntimeDebuggerClient, frameId: number, scope: "locals" | "members" | "globals"): Promise<number> {
    const response = await debuggerClient.request("scopes", { frameId });
    const match = bodyArray(response, "scopes").find((entry) => isRecord(entry) && typeof entry.name === "string" && entry.name.toLowerCase() === scope);
    if (!isRecord(match) || !Number.isInteger(match.variablesReference) || Number(match.variablesReference) < 1) {
      throw runtimeError("PRECONDITION_FAILED", `Godot debugger did not return the ${scope} scope`);
    }
    return Number(match.variablesReference);
  }

  private async readVariables(
    debuggerClient: RuntimeDebuggerClient,
    variablesReference: number,
    depth: number,
    offset: number,
    limit: number,
  ): Promise<{ variables: unknown[]; offset: number; returned: number; total: number; truncated: boolean }> {
    if (depth > 8) throw runtimeError("PRECONDITION_FAILED", "Debugger variable depth limit exceeded");
    const response = await this.requestVariables(debuggerClient, { variablesReference, start: offset, count: limit });
    const all = bodyArray(response, "variables");
    const selected = all.slice(0, limit);
    const body = isRecord(response.body) ? response.body : {};
    const reportedTotal = Number.isInteger(body.totalVariables) ? Number(body.totalVariables) : offset + all.length;
    const total = Math.min(2_048, Math.max(offset + selected.length, reportedTotal));
    this.debugTokens.consumeVariableEntries(selected.length);
    return {
      variables: selected.map((entry) => this.formatVariable(entry, depth)),
      offset,
      returned: selected.length,
      total,
      truncated: body.truncated === true || all.length > selected.length || offset + selected.length < total,
    };
  }

  private formatVariable(rawValue: unknown, depth: number): Record<string, unknown> {
    const raw = isRecord(rawValue) ? rawValue : {};
    const childReference = Number.isInteger(raw.variablesReference) ? Number(raw.variablesReference) : 0;
    const value = truncateUtf8(typeof raw.value === "string" ? raw.value : String(raw.value ?? ""), 4_096);
    const variableToken = childReference > 0 && depth <= 8
      ? this.debugTokens.issueVariable(childReference, depth)
      : undefined;
    return {
      name: boundedText(raw.name, "<unnamed>", 128),
      type: boundedText(raw.type, "unknown", 128),
      value: value.text,
      valueTruncated: value.truncated,
      hasChildren: childReference > 0,
      expandable: variableToken !== undefined,
      ...(variableToken === undefined ? {} : { variableToken }),
    };
  }

  private async resolveWatch(
    debuggerClient: RuntimeDebuggerClient,
    frameId: number,
    selector: Extract<RuntimeDebugOperationInput, { operation: "debug_watch" }>["selectors"][number],
  ): Promise<Record<string, unknown>> {
    let reference = await this.scopeReference(debuggerClient, frameId, selector.scope);
    let current: unknown;
    for (const [depthIndex, segment] of selector.path.entries()) {
      const response = await this.requestVariables(debuggerClient, { variablesReference: reference, start: 0, count: 256 });
      const all = bodyArray(response, "variables");
      const bounded = all.slice(0, 256);
      this.debugTokens.consumeVariableEntries(bounded.length);
      current = bounded.find((entry) => isRecord(entry) && String(entry.name) === String(segment));
      if (!current) return { selector, status: all.length > bounded.length ? "truncated" : "missing" };
      if (depthIndex === selector.path.length - 1) {
        return { selector, status: "found", variable: this.formatVariable(current, depthIndex + 1) };
      }
      if (!isRecord(current) || !Number.isInteger(current.variablesReference) || Number(current.variablesReference) < 1) {
        return { selector, status: "missing" };
      }
      reference = Number(current.variablesReference);
    }
    return { selector, status: "missing" };
  }

  private async requestVariables(debuggerClient: RuntimeDebuggerClient, argumentsValue: Record<string, unknown>): Promise<Record<string, unknown>> {
    return debuggerClient.request("variables", argumentsValue);
  }

  private projectSourcePath(absolutePath: string): string | undefined {
    if (absolutePath.startsWith("res://")) {
      if (absolutePath.toLowerCase().startsWith("res://addons/godot_mcp/")) return undefined;
      return absolutePath;
    }
    const projectRelative = relative(this.dependencies.project.rootRealPath, absolutePath);
    if (projectRelative === "" || projectRelative === ".." || projectRelative.startsWith(`..${sep}`) || isAbsolute(projectRelative)) return undefined;
    return `res://${projectRelative.split(sep).join("/")}`;
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
    const events = input.operation === "record_stop" ? result.trace!.events : inputTraceEvents(input);
    const expectedDeterministic = input.operation === "replay" || (input.operation === "sequence" && input.mode === "deterministic");
    const recordingMismatch = input.operation === "record_start"
      ? !result.receipt.recording
      : input.operation === "record_stop" && result.receipt.recording;
    const eventReceiptsMatch = result.receipt.events.every((eventReceipt, index) => {
      const event = events[index];
      return event !== undefined &&
        eventReceipt.index === index &&
        eventReceipt.kind === event.event.type &&
        eventReceipt.scheduledFrame === event.frameOffset;
    });
    if (
      result.receipt.eventCount !== events.length ||
      result.receipt.deliveredCount !== events.length ||
      result.receipt.events.length !== events.length ||
      result.receipt.deterministic !== expectedDeterministic ||
      recordingMismatch ||
      result.receipt.traceSha256 !== traceSha256({ schemaVersion: 1, events }) ||
      !eventReceiptsMatch
    ) throw runtimeError("GODOT_RUNTIME_ERROR", "Runtime input receipt does not match the requested trace");
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
      this.opaqueProfileId = null;
      this.debuggerSessionId = null;
      let cleanupError: unknown;
      try {
        await this.cleanupDebuggerClient();
      } catch (error) {
        cleanupError = error;
      }
      if (this.descriptor) {
        try {
          await this.descriptor.cleanup();
          this.descriptor = null;
        } catch (error) {
          cleanupError ??= error;
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

  private async cleanupDebuggerClient(): Promise<void> {
    const debuggerClient = this.debuggerClient;
    this.debuggerClient = null;
    this.debugTokens.clear();
    const sources = [...this.breakpointSources.keys()];
    this.breakpointSources.clear();
    if (!debuggerClient) return;
    let cleanupError: unknown;
    for (const absolutePath of sources) {
      try {
        await debuggerClient.request("setBreakpoints", {
          source: { name: absolutePath.split(sep).at(-1), path: absolutePath },
          breakpoints: [],
        }, 2_000);
      } catch (error) {
        if (!isTerminalDebuggerCleanupError(error)) cleanupError ??= error;
      }
    }
    try {
      await debuggerClient.request("disconnect", { terminateDebuggee: false }, 2_000);
    } catch (error) {
      if (!isTerminalDebuggerCleanupError(error)) cleanupError ??= error;
    }
    await debuggerClient.close().catch((error) => { cleanupError ??= error; });
    if (cleanupError) throw cleanupError;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bodyArray(response: Record<string, unknown>, key: string): unknown[] {
  if (!isRecord(response.body)) return [];
  const value = response.body[key];
  return Array.isArray(value) ? value : [];
}

function integerOr(value: unknown, fallback: number): number {
  return Number.isInteger(value) ? Number(value) : fallback;
}

function isPathInsideCaseInsensitive(parent: string, candidate: string): boolean {
  const relation = relative(parent.toLowerCase(), candidate.toLowerCase());
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function boundedText(value: unknown, fallback: string, maxLength: number): string {
  const text = typeof value === "string" ? value : fallback;
  return text.slice(0, maxLength);
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  let result = "";
  let bytes = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return { text: result, truncated: true };
}

function projectDebugStop(event: DebuggerStopEvent): DebugStopResult {
  const rawReason = event.reason.toLowerCase();
  const reason = rawReason.includes("breakpoint")
    ? "breakpoint"
    : rawReason.includes("exception")
      ? "exception"
      : rawReason.includes("step")
        ? "step"
        : rawReason.includes("pause")
          ? "pause"
          : "unknown";
  return DebugStopResultSchema.parse({ sequence: event.sequence, reason });
}

function normalizeDebugError(error: unknown): Error {
  if (error instanceof GodotMcpException) return error;
  if (error instanceof DebugTokenStoreError) return runtimeError("STALE_HANDLE", error.message);
  if (error instanceof DebuggerClientError) {
    switch (error.code) {
      case "INVALID_REQUEST":
        return runtimeError("INVALID_REQUEST", error.message);
      case "TIMEOUT":
        return runtimeError("TIMEOUT", error.message, true);
      case "TRANSPORT_ERROR":
        return runtimeError("TRANSPORT_ERROR", error.message, true);
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}

function isTerminalDebuggerCleanupError(error: unknown): boolean {
  return (error instanceof GodotMcpException && (error.code === "NOT_ATTACHED" || error.code === "TRANSPORT_ERROR")) ||
    (error instanceof DebuggerClientError && error.code === "TRANSPORT_ERROR");
}
