import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ExtensionContext, ExtensionRegistry } from "@godot-mcp/control-plane";
import { ToolResultSchema } from "@godot-mcp/protocol";

import { executeTool, type ToolExecutionDependencies } from "./executeTool.js";
import { toMcpToolResult } from "./toolResult.js";

const ExtensionCallSchema = z.object({ extension: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), operation: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), input: z.json() }).strict();
const RESERVED_AUDIT_KEYS = new Set(["extension", "operation"]);

function extensionAuditArguments(extension: string, operation: string, audit: () => Record<string, unknown>): Record<string, unknown> {
  const facts = audit();
  for (const key of Object.keys(facts)) if (RESERVED_AUDIT_KEYS.has(key)) throw new Error(`Extension audit metadata cannot override ${key}`);
  const serializedFacts = JSON.stringify(facts);
  if (serializedFacts === undefined) throw new Error("Extension audit metadata must be JSON serializable");
  if (Buffer.byteLength(serializedFacts) > 64 * 1024) throw new Error("Extension audit metadata exceeds 64 KiB");
  return { extension, operation, ...facts };
}

export interface ExtensionToolDependencies extends ToolExecutionDependencies {
  extensions: ExtensionRegistry;
  extensionContext(correlationId: string): ExtensionContext;
}

export function registerExtensionTools(server: McpServer, dependencies: ExtensionToolDependencies): void {
  server.registerTool("godot_extension", {
    title: "Run an allowlisted typed Godot MCP extension",
    description: "Invokes one startup-allowlisted typed extension through normal authorization and audit routing.",
    inputSchema: ExtensionCallSchema,
    outputSchema: ToolResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (rawInput) => {
    const input = ExtensionCallSchema.parse(rawInput);
    const serializedInput = JSON.stringify(input.input);
    if (serializedInput === undefined) throw new Error("Extension input must be JSON serializable");
    if (Buffer.byteLength(serializedInput) > 256 * 1024) throw new Error("Extension input exceeds 256 KiB");
    const definition = dependencies.extensions.resolve(input.extension, input.operation);
    let parsed: unknown;
    return toMcpToolResult(await executeTool(
      dependencies,
      definition.policy,
      input,
      async (correlationId) => {
        const supplied = dependencies.extensionContext(correlationId);
        const context: ExtensionContext = Object.freeze({
          project: Object.freeze({ ...supplied.project }),
          correlationId,
          evidence: Object.freeze({ putJson: supplied.evidence.putJson.bind(supplied.evidence) }),
        });
        const result = await definition.handler(context, parsed);
        const output = definition.outputSchema.parse(result);
        const serializedOutput = JSON.stringify(output);
        if (serializedOutput === undefined) throw new Error("Extension output must be JSON serializable");
        if (Buffer.byteLength(serializedOutput) > 512 * 1024) throw new Error("Extension output exceeds 512 KiB");
        return { data: output };
      },
      {
        auditArguments: () => {
          parsed = definition.inputSchema.parse(input.input);
          return extensionAuditArguments(input.extension, input.operation, () => definition.audit(parsed));
        },
        auditFallbackArguments: { extension: input.extension, operation: input.operation },
      },
    ));
  });
}
