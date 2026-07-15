import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ExecutedToolResult } from "./executeTool.js";

export function toMcpToolResult(executed: ExecutedToolResult): CallToolResult {
  const { result, image } = executed;
  return {
    content: [
      { type: "text", text: JSON.stringify(result) },
      ...(image ? [{ type: "image" as const, data: Buffer.from(image.data).toString("base64"), mimeType: image.mimeType }] : []),
    ],
    structuredContent: result as unknown as Record<string, unknown>,
    isError: !result.ok,
  };
}
