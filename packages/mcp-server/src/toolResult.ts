import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ExecutedToolResult } from "./executeTool.js";

export function toMcpToolResult(executed: ExecutedToolResult): CallToolResult {
  const { result, image, images } = executed;
  const imageContent = images ?? (image ? [image] : []);
  return {
    content: [
      { type: "text", text: JSON.stringify(result) },
      ...imageContent.map((item) => ({ type: "image" as const, data: Buffer.from(item.data).toString("base64"), mimeType: item.mimeType })),
    ],
    structuredContent: result as unknown as Record<string, unknown>,
    isError: !result.ok,
  };
}
