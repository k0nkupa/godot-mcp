import { describe, expect, it } from "vitest";

import { secureEditorArguments } from "./editor.js";

describe("secure editor launch", () => {
  it("forces the native DAP endpoint to collide with the authenticated editor debugger", () => {
    expect(secureEditorArguments("/private/project", 45678)).toEqual([
      "--editor",
      "--debug-server", "tcp://127.0.0.1:45678",
      "--dap-port", "45678",
      "--path", "/private/project",
      "--",
      "--godot-mcp-debug-port=45678",
      "--godot-mcp-dap-port=45678",
      "--godot-mcp-secure-editor-launch=1",
    ]);
  });

  it("rejects invalid shared ports", () => {
    expect(() => secureEditorArguments("/private/project", 0)).toThrow();
    expect(() => secureEditorArguments("/private/project", 65_536)).toThrow();
  });
});
