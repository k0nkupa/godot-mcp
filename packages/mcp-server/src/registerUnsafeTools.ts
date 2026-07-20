import { createHash } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { UNSAFE_POLICY } from "@godot-mcp/control-plane";
import { ToolResultSchema, UnsafeFixtureOperationInputSchema, type UnsafeFixtureOperationInput } from "@godot-mcp/protocol";

import { executeTool, type ExecutedPayload, type ToolExecutionDependencies } from "./executeTool.js";
import { toMcpToolResult } from "./toolResult.js";

export interface UnsafeFixtureController {
  execute(input: UnsafeFixtureOperationInput, correlationId: string): Promise<ExecutedPayload>;
}

export interface UnsafeToolDependencies extends ToolExecutionDependencies { unsafeFixture: UnsafeFixtureController }

export function registerUnsafeTools(server: McpServer, dependencies: UnsafeToolDependencies): void {
  server.registerTool("godot_unsafe_fixture", {
    title: "UNSAFE: execute unsandboxed code in a registered disposable fixture",
    description: "Runs arbitrary GDScript as your OS user in a separately registered disposable fixture. This is not a sandbox.",
    inputSchema: UnsafeFixtureOperationInputSchema,
    outputSchema: ToolResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (input) => toMcpToolResult(await executeTool(
    dependencies,
    UNSAFE_POLICY,
    input,
    (correlationId) => dependencies.unsafeFixture.execute(input, correlationId),
    { auditArguments: unsafeAuditArguments(input) },
  )));
}

export function unsafeAuditArguments(input: UnsafeFixtureOperationInput): Record<string, unknown> {
  return input.operation === "execute_start"
    ? { operation: input.operation, sourceSha256: createHash("sha256").update(input.source).digest("hex"), sourceBytes: Buffer.byteLength(input.source), deadlineMs: input.deadlineMs, unsafe: true, sandboxed: false }
    : { operation: input.operation, unsafe: true, sandboxed: false };
}
