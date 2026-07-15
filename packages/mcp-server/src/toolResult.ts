import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ToolResult } from "@godot-mcp/protocol";

export function toMcpToolResult(result: ToolResult): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result as unknown as Record<string, unknown>,
    isError: !result.ok,
  };
}
