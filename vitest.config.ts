import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

const packages = [
  "protocol",
  "control-plane",
  "bridge-client",
  "mcp-server",
  "cli",
  "testkit",
] as const;

export default defineConfig({
  resolve: {
    alias: Object.fromEntries(
      packages.map((name) => [
        `@godot-mcp/${name}`,
        resolve(`packages/${name}/src/index.ts`),
      ]),
    ),
  },
  test: {
    environment: "node",
    // Godot editor and runtime integration files compete for the same host UI
    // resources, which can starve otherwise bounded bridge deadlines.
    fileParallelism: false,
    include: ["tests/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    restoreMocks: true,
    testTimeout: 10_000,
  },
});
