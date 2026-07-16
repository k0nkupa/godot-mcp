import { describe, expect, it } from "vitest";

import { childHasExited, godotRuntimeArguments, scrubRuntimeEnvironment } from "./runtimeProcess.js";

describe("owned runtime launch", () => {
  it("builds only fixed Godot arguments", () => {
    expect(godotRuntimeArguments({
      projectRoot: "/private/project",
      debugPort: 6007,
      descriptorPath: "/private/runtime/runtime.json",
    })).toEqual([
      "--path", "/private/project",
      "--scene", "res://addons/godot_mcp/runtime/runtime_harness.tscn",
      "--remote-debug", "tcp://127.0.0.1:6007",
      "--", "--godot-mcp-runtime-descriptor=/private/runtime/runtime.json",
    ]);
  });

  it("keeps only the runtime allowlist and removes credentials", () => {
    expect(scrubRuntimeEnvironment({ PATH: "/bin", HOME: "/tmp/home", LANG: "en_NZ", AWS_SECRET_ACCESS_KEY: "secret", TOKEN: "secret" })).toEqual({ PATH: "/bin", HOME: "/tmp/home", LANG: "en_NZ" });
  });

  it("treats signal-terminated children as exited", () => {
    expect(childHasExited({ exitCode: null, signalCode: "SIGTERM" })).toBe(true);
    expect(childHasExited({ exitCode: null, signalCode: null })).toBe(false);
  });
});
