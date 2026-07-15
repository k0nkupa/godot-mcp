import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export async function connectStdio(
  server: McpServer,
  cleanup: () => Promise<void> = async () => undefined,
): Promise<void> {
  const transport = new StdioServerTransport();
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      await cleanup();
    })();
    return closePromise;
  };
  const signalHandler = (): void => {
    void close().then(() => {
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", signalHandler);
  process.once("SIGTERM", signalHandler);
  try {
    await server.connect(transport);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    await close();
    throw error;
  }
}
