import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { projectGodotArguments, scrubProjectEnvironment } from "./projectProcess.js";

const root = "/private/tmp/godot-project";
const artifacts = join(root, ".godot/evidence/godot-mcp/artifacts/job");

describe("owned project process contract", () => {
  it.each([
    [{ operation: "import", projectRoot: root }, ["--headless", "--editor", "--path", root, "--import"]],
    [{ operation: "run", projectRoot: root, headless: true }, ["--headless", "--path", root]],
    [{ operation: "run", projectRoot: root, headless: false, scenePath: "res://scenes/main.tscn" }, ["--path", root, "--scene", "res://scenes/main.tscn"]],
    [{ operation: "build", projectRoot: root }, ["--headless", "--path", root, "--build-solutions", "--quit"]],
    [{ operation: "export", projectRoot: root, artifactRoot: artifacts, mode: "release", preset: "macOS", outputPath: join(artifacts, "game.zip") }, ["--headless", "--path", root, "--export-release", "macOS", join(artifacts, "game.zip")]],
    [{ operation: "export", projectRoot: root, artifactRoot: artifacts, mode: "debug", preset: "macOS", outputPath: join(artifacts, "game.zip") }, ["--headless", "--path", root, "--export-debug", "macOS", join(artifacts, "game.zip")]],
    [{ operation: "export", projectRoot: root, artifactRoot: artifacts, mode: "pack", preset: "PCK", outputPath: join(artifacts, "game.pck") }, ["--headless", "--path", root, "--export-pack", "PCK", join(artifacts, "game.pck")]],
  ] as const)("maps only fixed Godot arguments %#", (input, expected) => {
    expect(projectGodotArguments(input)).toEqual(expected);
  });

  it("rejects export path escape and hostile scene paths", () => {
    expect(() => projectGodotArguments({ operation: "export", projectRoot: root, artifactRoot: artifacts, mode: "release", preset: "safe", outputPath: "/private/tmp/escape.zip" }))
      .toThrow(/artifact root/i);
    expect(() => projectGodotArguments({ operation: "run", projectRoot: root, headless: true, scenePath: "res://../escape.tscn" }))
      .toThrow(/scene/i);
  });

  it("allows toolchain locations but strips credentials, proxies, and MCP/session state", () => {
    expect(scrubProjectEnvironment({
      HOME: "/tmp/home", PATH: "/bin", TMPDIR: "/tmp", LANG: "en_NZ.UTF-8",
      DOTNET_ROOT: "/opt/dotnet", JAVA_HOME: "/opt/java", ANDROID_HOME: "/opt/android",
      AWS_SECRET_ACCESS_KEY: "secret", GITHUB_TOKEN: "secret", HTTPS_PROXY: "http://user:pass@example.com",
      GODOT_MCP_SESSION: "secret", SSH_AUTH_SOCK: "/tmp/agent",
    })).toEqual({
      HOME: "/tmp/home", PATH: "/bin", TMPDIR: "/tmp", LANG: "en_NZ.UTF-8",
      DOTNET_ROOT: "/opt/dotnet", JAVA_HOME: "/opt/java", ANDROID_HOME: "/opt/android",
    });
  });
});
