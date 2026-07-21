import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { startBridgeServer } from "@godot-mcp/bridge-client";
import { createSecureEditorLaunchAttestation, initProject, secureEditorArguments } from "@godot-mcp/cli";
import {
  createRuntimeDescriptor,
  JsonlAuditSink,
  OwnedGodotProcess,
  readProjectIdentity,
  RuntimeService,
  type RuntimeDescriptorMaterial,
} from "@godot-mcp/control-plane";
import { copyFixture, findGodotBinary, reserveLoopbackPort, runGodot, waitUntil } from "@godot-mcp/testkit";
import { expect, test } from "vitest";

import {
  readInputFixtureReplayState,
  type InputFixtureReplayState,
  type RuntimeProperty,
} from "../helpers/input-fixture-state.js";

const handleRunId = "019f644c-1379-79c0-825e-66a4b7653bd1";

test("injects, records, and deterministically replays bounded runtime input", async () => {
  const project = await copyFixture();
  const previousRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = join(project.root, "runtime-dir");
  let editor: ReturnType<typeof spawn> | undefined;
  let launchAttestation: Awaited<ReturnType<typeof createSecureEditorLaunchAttestation>> | undefined;
  let editorOutput = "";
  let runtimeOutput = "";
  let phase = "setup";
  try {
    expect((await runGodot(["--headless", "--editor", "--path", project.root, "--import"])).exitCode).toBe(0);
    await initProject(project.root, resolve(process.cwd(), "addons/godot_mcp"), process.env.GODOT_BIN);
    await project.snapshot();
    const identity = await readProjectIdentity(project.root);
    const manifest = JSON.parse(await readFile(join(project.root, ".godot/godot-mcp/install-manifest.json"), "utf8")) as { manifestSha256: string };
    const bridge = await startBridgeServer({
      project: identity,
      grants: { tiers: ["observe", "runtime_control"], packs: ["core", "runtime", "input"] },
      addonManifestSha256: manifest.manifestSha256,
      auditSink: new JsonlAuditSink(join(dirname(project.root), "runtime-input-audit.jsonl")),
    });
    try {
      const debugServerPort = await reserveLoopbackPort();
      launchAttestation = await createSecureEditorLaunchAttestation(identity.projectId, debugServerPort);
      editor = spawn(await findGodotBinary(), [
        "--headless",
        ...secureEditorArguments(project.root, debugServerPort, launchAttestation.path),
      ], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      editor.stdout?.on("data", (chunk: Buffer) => { editorOutput += chunk.toString(); });
      editor.stderr?.on("data", (chunk: Buffer) => { editorOutput += chunk.toString(); });
      const session = await bridge.waitForAttachment(15_000);
      let activeDescriptor: RuntimeDescriptorMaterial | undefined;
      const runtime = new RuntimeService({
        project: identity,
        sessionId: () => session.sessionId,
        godotBin: await findGodotBinary(),
        createDescriptor: async (input) => {
          activeDescriptor = await createRuntimeDescriptor(input);
          return activeDescriptor;
        },
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
        capture: async () => { throw new Error("capture is not used by the input fixture"); },
		cleanup: async () => {
		  await session.request("runtime.cleanup", {}, { timeoutMs: 5_000 });
		},
      });
      try {
        phase = "launch";
        const launched = await runtime.launch({ scenePath: "res://input/input_fixture.tscn", startupTimeoutMs: 15_000 });
        expect(launched.handle.runId).not.toBe(handleRunId);

        phase = "record-and-realtime-sequence";
        await runtime.input({ operation: "record_start", handle: launched.handle });
        await runtime.input({
          operation: "send",
          handle: launched.handle,
          event: { type: "action", action: "phase_4_accept", pressed: true, strengthMillionths: 1_000_000 },
        });
        const sequence = await runtime.input({
          operation: "sequence",
          handle: launched.handle,
          mode: "realtime",
          timeoutMs: 10_000,
          events: [
            { frameOffset: 0, event: { type: "key", keycode: 65, physicalKeycode: 0, unicode: 0, pressed: true, echo: false, modifiers: { alt: false, ctrl: false, meta: false, shift: false } } },
            { frameOffset: 1, event: { type: "mouse_button", position: { x: 100, y: 120 }, viewportPath: ".", coordinateSpace: "viewport", buttonIndex: 1, pressed: true, doubleClick: false, factorMillionths: 1_000_000, modifiers: { alt: false, ctrl: false, meta: false, shift: false } } },
            { frameOffset: 1, event: { type: "mouse_motion", position: { x: 140, y: 160 }, viewportPath: ".", coordinateSpace: "viewport", relative: { x: 40, y: 40 }, velocity: { x: 40, y: 40 }, pressureMillionths: 0, tiltMillionths: { x: 0, y: 0 }, modifiers: { alt: false, ctrl: false, meta: false, shift: false } } },
            { frameOffset: 1, event: { type: "scroll", position: { x: 140, y: 160 }, viewportPath: ".", coordinateSpace: "viewport", delta: { x: 2, y: -3 }, modifiers: { alt: false, ctrl: false, meta: false, shift: false } } },
            { frameOffset: 2, event: { type: "touch", position: { x: 20, y: 30 }, viewportPath: ".", coordinateSpace: "viewport", index: 0, pressed: true, canceled: false, doubleTap: false } },
            { frameOffset: 2, event: { type: "touch", position: { x: 40, y: 50 }, viewportPath: ".", coordinateSpace: "viewport", index: 1, pressed: true, canceled: false, doubleTap: false } },
            { frameOffset: 2, event: { type: "touch_drag", position: { x: 45, y: 55 }, viewportPath: ".", coordinateSpace: "viewport", index: 1, relative: { x: 5, y: 5 }, velocity: { x: 5, y: 5 }, pressureMillionths: 500_000, tiltMillionths: { x: 0, y: 0 } } },
            { frameOffset: 3, event: { type: "pan_gesture", position: { x: 50, y: 60 }, viewportPath: ".", coordinateSpace: "viewport", delta: { x: 7, y: -8 } } },
            { frameOffset: 3, event: { type: "magnify_gesture", position: { x: 50, y: 60 }, viewportPath: ".", coordinateSpace: "viewport", factorMillionths: 1_250_000 } },
            { frameOffset: 3, event: { type: "joypad_button", device: 0, buttonIndex: 1, pressed: true, pressureMillionths: 1_000_000 } },
            { frameOffset: 3, event: { type: "joypad_motion", device: 0, axis: 1, axisValueMillionths: -500_000 } },
          ],
        });
        expect(sequence.receipt).toMatchObject({ eventCount: 11, deliveredCount: 11, deterministic: false });
        await runtime.execute({ operation: "wait", handle: launched.handle, timeoutMs: 5_000, condition: { type: "property_equals", nodePath: ".", property: "last_kind", value: "joypad_motion" } });
        const stopped = await runtime.input({ operation: "record_stop", handle: launched.handle });
        expect(stopped.trace?.events).toHaveLength(12);
        expect(stopped.receipt.traceSha256).toMatch(/^[a-f0-9]{64}$/);

        phase = "assert-root-state";
        const rootNode = await runtime.execute({ operation: "node", handle: launched.handle, nodePath: ".", includeProperties: true, includeSignals: false }) as { properties: Array<{ name: string; value: unknown }> };
        const property = (name: string) => rootNode.properties.find((entry) => entry.name === name)?.value;
        expect(property("action_pressed")).toBe(true);
        expect(property("keycode")).toBe(65);
        expect(property("mouse_x")).toBe(140);
        expect(property("mouse_y")).toBe(160);
        expect(property("scroll_x")).toBe(2);
        expect(property("scroll_y")).toBe(-3);
        expect(property("active_touch_count")).toBe(2);
        expect(property("touch_drag_x")).toBe(45);
        expect(property("pan_x")).toBe(7);
        expect(property("pan_y")).toBe(-8);
        expect(property("magnify_millionths")).toBe(1_250_000);
        expect(property("joy_button_pressed")).toBe(true);
        expect(property("joy_axis_millionths")).toBe(-500_000);

        phase = "embedded-normalized-coordinate";
        await runtime.input({
          operation: "send",
          handle: launched.handle,
          event: { type: "touch", position: { x: 250_000, y: 750_000 }, viewportPath: "Embedded", coordinateSpace: "normalized", index: 2, pressed: true, canceled: false, doubleTap: false },
        });
        await runtime.execute({ operation: "wait", handle: launched.handle, timeoutMs: 5_000, condition: { type: "property_equals", nodePath: "Embedded/Receiver", property: "event_count", value: 1 } });
        const embedded = await runtime.execute({ operation: "node", handle: launched.handle, nodePath: "Embedded/Receiver", includeProperties: true, includeSignals: false }) as { properties: Array<{ name: string; value: unknown }> };
        const embeddedProperty = (name: string) => embedded.properties.find((entry) => entry.name === name)?.value;
        expect(embeddedProperty("last_x")).toBe(80);
        expect(embeddedProperty("last_y")).toBe(135);

        phase = "deterministic-sequence-and-replay";
        await runtime.execute({ operation: "pause", handle: launched.handle });
        const deterministic = await runtime.input({
          operation: "sequence",
          handle: launched.handle,
          mode: "deterministic",
          timeoutMs: 10_000,
          events: [
            { frameOffset: 0, event: { type: "action", action: "phase_4_accept", pressed: false, strengthMillionths: 0 } },
            { frameOffset: 2, event: { type: "action", action: "phase_4_accept", pressed: true, strengthMillionths: 1_000_000 } },
          ],
        });
        expect(deterministic.receipt).toMatchObject({ deterministic: true, deliveredCount: 2 });
        expect(runtime.snapshot().state).toBe("paused");
        const replay = await runtime.input({
          operation: "replay",
          handle: launched.handle,
          mode: "deterministic",
          timeoutMs: 10_000,
          trace: { schemaVersion: 1, events: deterministic.receipt.events.map((event, index) => ({
            frameOffset: event.scheduledFrame,
            event: index === 0
              ? { type: "action" as const, action: "phase_4_accept", pressed: false, strengthMillionths: 0 }
              : { type: "action" as const, action: "phase_4_accept", pressed: true, strengthMillionths: 1_000_000 },
          })) },
        });
        expect(replay.receipt).toMatchObject({ deterministic: true, deliveredCount: 2 });
        expect(runtime.snapshot().state).toBe("paused");

		phase = "fresh-scene-reset";
		await runtime.execute({ operation: "resume", handle: launched.handle });
		await runtime.input({
			operation: "send",
			handle: launched.handle,
			event: { type: "key", keycode: 82, physicalKeycode: 0, unicode: 0, pressed: true, echo: false, modifiers: { alt: false, ctrl: false, meta: false, shift: false } },
		});
		await waitUntil(async () => {
			try {
				const node = await runtime.execute({ operation: "node", handle: launched.handle, nodePath: ".", includeProperties: true, includeSignals: false }) as { properties: Array<{ name: string; value: unknown }> };
				const property = (name: string) => node.properties.find((entry) => entry.name === name)?.value;
				return property("replay_event_count") === 0
					&& Number(property("frame_counter")) > 0
					&& property("inherited_reload_key_pressed") === false;
			} catch {
				return false;
			}
		}, 5_000, 50);

		phase = "fresh-run-determinism";
        const pinnedTrace = {
          schemaVersion: 1 as const,
          events: [
            { frameOffset: 0, event: { type: "action" as const, action: "phase_4_accept", pressed: true, strengthMillionths: 1_000_000 } },
            { frameOffset: 1, event: { type: "key" as const, keycode: 66, physicalKeycode: 0, unicode: 0, pressed: true, echo: false, modifiers: { alt: false, ctrl: false, meta: false, shift: false } } },
            { frameOffset: 2, event: { type: "action" as const, action: "phase_4_accept", pressed: false, strengthMillionths: 0 } },
          ],
        };
        const deterministicRuns: Array<{
          replayState: InputFixtureReplayState;
          frameDelta: number;
          deliveredFrames: number[];
        }> = [];
        for (let iteration = 0; iteration < 2; iteration += 1) {
		  phase = `fresh-run-${iteration}-pause`;
		  await runtime.execute({ operation: "pause", handle: launched.handle });
		  phase = `fresh-run-${iteration}-before-query`;
		  const before = await runtime.execute({ operation: "node", handle: launched.handle, nodePath: ".", includeProperties: true, includeSignals: false }) as { properties: Array<{ name: string; value: unknown }> };
		  expect(before.properties.find((entry) => entry.name === "inherited_reload_key_pressed")?.value).toBe(false);
		  const beforeFrame = Number(before.properties.find((entry) => entry.name === "frame_counter")?.value);
		  phase = `fresh-run-${iteration}-replay`;
		  const replayed = await runtime.input({ operation: "replay", handle: launched.handle, mode: "deterministic", timeoutMs: 10_000, trace: pinnedTrace });
		  phase = `fresh-run-${iteration}-after-query`;
		  const after = await runtime.execute({ operation: "node", handle: launched.handle, nodePath: ".", includeProperties: true, includeSignals: false }) as { properties: RuntimeProperty[] };
          const afterProperty = (name: string) => after.properties.find((entry) => entry.name === name)?.value;
          deterministicRuns.push({
            replayState: readInputFixtureReplayState(after.properties),
            frameDelta: Number(afterProperty("frame_counter")) - beforeFrame,
            deliveredFrames: replayed.receipt.events.map((event) => event.deliveredFrame),
          });
		  expect(runtime.snapshot().state).toBe("paused");
		  if (iteration === 0) {
			await runtime.execute({ operation: "resume", handle: launched.handle });
			phase = `fresh-run-${iteration}-reset`;
			await runtime.input({
			  operation: "send",
			  handle: launched.handle,
			  event: { type: "key", keycode: 82, physicalKeycode: 0, unicode: 0, pressed: true, echo: false, modifiers: { alt: false, ctrl: false, meta: false, shift: false } },
			});
			await waitUntil(async () => {
			  try {
				const node = await runtime.execute({ operation: "node", handle: launched.handle, nodePath: ".", includeProperties: true, includeSignals: false }) as { properties: Array<{ name: string; value: unknown }> };
				const property = (name: string) => node.properties.find((entry) => entry.name === name)?.value;
				return property("replay_event_count") === 0
					&& Number(property("frame_counter")) > 0
					&& property("inherited_reload_key_pressed") === false;
			  } catch {
				return false;
			  }
			}, 5_000, 50);
		  }
        }
        expect(deterministicRuns[0]).toEqual(deterministicRuns[1]);
        expect(deterministicRuns[0]?.replayState.deliveryOrder).toBe("action,key,action");
        expect(deterministicRuns[0]?.frameDelta).toBe(3);
        expect(deterministicRuns[0]?.deliveredFrames).toEqual([0, 1, 2]);
      } finally {
        await runtime.close();
      }
    } catch (error) {
      throw new Error(`Phase: ${phase}\n${String(error)}\nEditor:\n${editorOutput}\nRuntime:\n${runtimeOutput}`);
    } finally {
      await bridge.close();
    }
    expect(await project.diffFromOriginal()).toEqual([]);
  } finally {
    if (editor?.exitCode === null) editor.kill("SIGTERM");
    await launchAttestation?.cleanup();
    if (previousRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntimeDirectory;
    await project.cleanup();
  }
}, 90_000);
