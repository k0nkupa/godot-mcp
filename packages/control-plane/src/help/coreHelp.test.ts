import { expect, it } from "vitest";

import { getCoreHelp } from "./coreHelp.js";

it("documents the explicitly granted runtime tools", () => {
  expect(getCoreHelp("runtime")).toMatchObject({ tool: "godot_runtime", readOnly: false });
  expect(getCoreHelp("runtime_capture")).toMatchObject({
    tool: "godot_runtime_capture",
    readOnly: false,
  });
  expect(getCoreHelp("input")).toMatchObject({
    tool: "godot_input",
    readOnly: false,
    summary: expect.stringContaining("non-passive"),
  });
});
