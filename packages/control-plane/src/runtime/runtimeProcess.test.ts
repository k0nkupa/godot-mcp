import { describe, expect, it } from "vitest";

import { childHasExited, godotRuntimeArguments, lsofShowsLoopbackListener, scrubRuntimeEnvironment } from "./runtimeProcess.js";

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

  it("accepts only the expected process loopback debugger listener", () => {
    expect(lsofShowsLoopbackListener("p42\nn127.0.0.1:6007\n", 42, 6007)).toBe(true);
    expect(lsofShowsLoopbackListener("p99\nn127.0.0.1:6007\n", 42, 6007)).toBe(false);
    expect(lsofShowsLoopbackListener("p42\nn*:6007\n", 42, 6007)).toBe(false);
    expect(lsofShowsLoopbackListener("p42\nn127.0.0.1:6008\n", 42, 6007)).toBe(false);
  });
});
