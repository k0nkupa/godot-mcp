import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const names = [
  "protocol",
  "control-plane",
  "bridge-client",
  "mcp-server",
  "cli",
  "testkit",
] as const;

describe("workspace package contract", () => {
  it.each(names)("defines @godot-mcp/%s at product version 0.1.0", async (name) => {
    const json = JSON.parse(await readFile(`packages/${name}/package.json`, "utf8")) as unknown;

    expect(json).toMatchObject({
      name: `@godot-mcp/${name}`,
      version: "0.1.0",
      type: "module",
    });
  });
});
