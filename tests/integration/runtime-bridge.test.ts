import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

import { startBridgeServer } from "@godot-mcp/bridge-client";
import { initProject } from "@godot-mcp/cli";
import { JsonlAuditSink, OwnedGodotProcess, readProjectIdentity, RuntimeService } from "@godot-mcp/control-plane";
import type { RuntimeCaptureFrameMetadata } from "@godot-mcp/protocol";
import { copyFixture, findGodotBinary, reserveLoopbackPort, runGodot, waitUntil } from "@godot-mcp/testkit";
import { expect, test } from "vitest";

test("launches, inspects, controls, and cleans one authenticated runtime", async () => {
  const project = await copyFixture();
  const previousRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = join(project.root, "runtime-dir");
  let editor: ReturnType<typeof spawn> | undefined;
  let editorOutput = "";
  let runtimeOutput = "";
  try {
    expect((await runGodot(["--headless", "--editor", "--path", project.root, "--import"])).exitCode).toBe(0);
    await initProject(project.root, resolve(process.cwd(), "addons/godot_mcp"), process.env.GODOT_BIN);
    await project.snapshot();
    const identity = await readProjectIdentity(project.root);
    const manifest = JSON.parse(await readFile(join(project.root, ".godot/godot-mcp/install-manifest.json"), "utf8")) as { manifestSha256: string };
    const bridge = await startBridgeServer({
      project: identity,
      grants: { tiers: ["observe", "runtime_control"], packs: ["core", "runtime"] },
      addonManifestSha256: manifest.manifestSha256,
      auditSink: new JsonlAuditSink(join(dirname(project.root), "runtime-audit.jsonl")),
    });
    try {
      const debugServerPort = await reserveLoopbackPort();
      editor = spawn(await findGodotBinary(), [
        "--headless", "--editor", "--debug-server", `tcp://127.0.0.1:${debugServerPort}`,
        "--path", project.root, "--", `--godot-mcp-debug-port=${debugServerPort}`,
      ], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      editor.stdout?.on("data", (chunk: Buffer) => { editorOutput += chunk.toString(); });
      editor.stderr?.on("data", (chunk: Buffer) => { editorOutput += chunk.toString(); });
      const session = await bridge.waitForAttachment(15_000);
      const runtime = new RuntimeService({
        project: identity,
        sessionId: () => session.sessionId,
        godotBin: await findGodotBinary(),
        launchProcess: async (input) => {
          const owned = await OwnedGodotProcess.launch(input);
          const diagnostics = owned.diagnostics.bind(owned);
          const stop = owned.stop.bind(owned);
          return {
            pid: owned.pid,
            fingerprint: owned.fingerprint,
            wait: owned.wait.bind(owned),
            diagnostics,
            async stop(graceMs?: number): Promise<void> {
              runtimeOutput = diagnostics();
              await stop(graceMs);
              runtimeOutput = diagnostics();
            },
          };
        },
        prepare: async ({ descriptor }) => (await session.request<{ debugPort: number }>("runtime.prepare", { descriptor }, { timeoutMs: 5_000 })).data,
        command: async (operation, input, timeoutMs = 10_000) => (await session.request<Record<string, unknown>>("runtime.command", { operation, ...input }, { timeoutMs })).data,
        capture: async (input, timeoutMs = 15_000) => {
          const response = await session.request<RuntimeCaptureFrameMetadata>("runtime.capture", input, { timeoutMs, maxResponseBytes: 8 * 1024 * 1024 });
          return {
            data: response.data,
            ...(response.binary === undefined ? {} : { binary: response.binary }),
            ...(response.binarySha256 === undefined ? {} : { binarySha256: response.binarySha256 }),
          };
        },
      });
      try {
        const launched = await runtime.launch({ scenePath: "res://runtime/runtime_fixture.tscn", startupTimeoutMs: 15_000 });
        expect(launched.root).toMatchObject({ pid: expect.any(Number), scenePath: "res://runtime/runtime_fixture.tscn" });
        const tree = await runtime.execute({ operation: "tree", handle: launched.handle, root: ".", maxDepth: 4, maxNodes: 20 }) as { nodes: Array<{ nodePath: string }> };
        expect(tree.nodes.map((node) => node.nodePath)).toEqual([".", "Backdrop", "Accent", "Status", "Nested", "Nested/Marker", "FreeingSignal"]);
        const node = await runtime.execute({ operation: "node", handle: launched.handle, nodePath: ".", includeProperties: true, includeSignals: true }) as { properties: Array<{ name: string; value: unknown }>; signals: unknown[] };
        expect(node.properties).toEqual(expect.arrayContaining([expect.objectContaining({ name: "fixture_name", value: "phase-3-runtime" })]));
        expect(node.properties).toEqual(expect.arrayContaining([expect.objectContaining({ name: "ready_current_scene_matches", value: true })]));
        expect(node.properties).toEqual(expect.arrayContaining([expect.objectContaining({ name: "api_key", value: "[redacted]" })]));
        expect(JSON.stringify(node.signals)).toContain("milestone");
        const logs = await runtime.execute({ operation: "logs", handle: launched.handle, afterSequence: 0, levels: ["log"], limit: 20 }) as { records: Array<{ message: string }> };
        expect(logs.records.map((record) => record.message).join("\n")).toContain("phase-3 runtime ready");
        await expect(runtime.execute({ operation: "wait", handle: launched.handle, timeoutMs: 5_000, condition: { type: "property_equals", nodePath: ".", property: "phase", value: "ready" } })).resolves.toMatchObject({ satisfied: true });
        await expect(runtime.execute({ operation: "wait", handle: launched.handle, timeoutMs: 1_000, condition: { type: "property_equals", nodePath: ".", property: "missing_property", value: null } })).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });
        await expect(runtime.execute({ operation: "wait", handle: launched.handle, timeoutMs: 1_000, condition: { type: "property_matches", nodePath: ".", property: "api_key", pattern: ".*" } })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
        const invalidPatternStartedAt = Date.now();
        await expect(runtime.execute({ operation: "wait", handle: launched.handle, timeoutMs: 5_000, condition: { type: "property_matches", nodePath: ".", property: "phase", pattern: "[" } })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
        expect(Date.now() - invalidPatternStartedAt).toBeLessThan(1_000);
        await expect(runtime.execute({ operation: "wait", handle: launched.handle, timeoutMs: 5_000, condition: { type: "signal_emitted", nodePath: "FreeingSignal", signal: "departing" } })).resolves.toMatchObject({ satisfied: true });
        await expect(runtime.execute({ operation: "wait", handle: launched.handle, timeoutMs: 5_000, condition: { type: "signal_emitted", nodePath: ".", signal: "milestone" } })).resolves.toMatchObject({ satisfied: true });
        const captured = await runtime.capture({ handle: launched.handle, maxWidth: 640, maxHeight: 360, frameCount: 2, intervalFrames: 2, advancePaused: false });
        expect(captured.frames).toHaveLength(2);
        for (const [frameIndex, frame] of captured.frames.entries()) {
          expect(Array.from(frame.data.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
          expect(frame.metadata).toMatchObject({ mimeType: "image/png", frameIndex });
          expect(frame.metadata.width).toBeLessThanOrEqual(640);
          expect(frame.metadata.height).toBeLessThanOrEqual(360);
          expect(frame.metadata.sha256).toBe(createHash("sha256").update(frame.data).digest("hex"));
        }
        expect(captured.frames[0]?.metadata.sha256).not.toBe(captured.frames[1]?.metadata.sha256);
        await runtime.execute({ operation: "pause", handle: launched.handle });
        expect(runtime.snapshot().state).toBe("paused");
        const beforeStep = await runtime.execute({ operation: "node", handle: launched.handle, nodePath: ".", includeProperties: true, includeSignals: false }) as { properties: Array<{ name: string; value: unknown }> };
        await runtime.execute({ operation: "step", handle: launched.handle, frames: 2 });
        const afterStep = await runtime.execute({ operation: "node", handle: launched.handle, nodePath: ".", includeProperties: true, includeSignals: false }) as { properties: Array<{ name: string; value: unknown }> };
        const property = (result: { properties: Array<{ name: string; value: unknown }> }, name: string) => Number(result.properties.find((entry) => entry.name === name)?.value);
        expect(property(afterStep, "frame_counter") - property(beforeStep, "frame_counter")).toBe(2);
        await expect(runtime.execute({ operation: "pause", handle: { ...launched.handle, generation: launched.handle.generation + 1 } })).rejects.toMatchObject({ code: "STALE_HANDLE" });
        await runtime.execute({ operation: "resume", handle: launched.handle });
        await runtime.execute({ operation: "stop", handle: launched.handle });
        const transitionRun = await runtime.launch({ scenePath: "res://runtime/runtime_transition_source.tscn", startupTimeoutMs: 15_000 });
        let transitionedTree: { nodes: Array<{ nodePath: string }> } | undefined;
        await waitUntil(async () => {
          transitionedTree = await runtime.execute({ operation: "tree", handle: transitionRun.handle, root: ".", maxDepth: 2, maxNodes: 10 }) as { nodes: Array<{ nodePath: string }> };
          return transitionedTree.nodes.some((entry) => entry.nodePath === "TransitionedMarker");
        }, 5_000, 50);
        expect(transitionedTree?.nodes.map((entry) => entry.nodePath)).toEqual([".", "TransitionedMarker"]);
        await runtime.execute({ operation: "stop", handle: transitionRun.handle });
        expect(runtime.snapshot().state).toBe("stopped");
      } finally {
        await runtime.close();
      }
    } catch (error) {
      throw new Error(`${String(error)}\nEditor:\n${editorOutput}\nRuntime:\n${runtimeOutput}`);
    } finally {
      await bridge.close();
    }
    expect(await project.diffFromOriginal()).toEqual([]);
  } finally {
    if (editor?.exitCode === null) editor.kill("SIGTERM");
    if (previousRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntimeDirectory;
    await project.cleanup();
  }
}, 60_000);
