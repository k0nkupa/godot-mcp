import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  deriveSessionKey,
  JsonlAuditSink,
  readProjectIdentity,
  signEnvelope,
  type SessionDescriptor,
  type SessionGrants,
} from "@godot-mcp/control-plane";
import { BRIDGE_PROTOCOL_VERSION, PRODUCT_VERSION } from "@godot-mcp/protocol";
import { copyFixture } from "@godot-mcp/testkit";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import {
  startBridgeServer,
  type BridgeServer,
  type StartBridgeServerOptions,
} from "./index.js";

const cleanups: Array<() => Promise<void>> = [];
const originalRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
const grants: SessionGrants = { tiers: ["observe"], packs: ["core"] };
const addonManifestSha256 = "a".repeat(64);

afterEach(async () => {
  if (originalRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = originalRuntimeDirectory;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startTestBridge(
  overrides: Partial<Pick<StartBridgeServerOptions, "now" | "handshakeTimeoutMs">> = {},
): Promise<BridgeServer> {
  const project = await copyFixture();
  cleanups.push(project.cleanup);
  process.env.XDG_RUNTIME_DIR = join(project.root, "runtime");
  const identity = await readProjectIdentity(project.root);
  return startBridgeServer({
    project: identity,
    grants,
    addonManifestSha256,
    auditSink: new JsonlAuditSink(join(project.root, "audit.jsonl")),
    ...overrides,
  });
}

async function readDescriptor(path: string): Promise<SessionDescriptor> {
  return JSON.parse(await readFile(path, "utf8")) as SessionDescriptor;
}

async function pairClient(
  descriptor: SessionDescriptor,
  overrides: Partial<{ token: string; project: SessionDescriptor["project"] }> = {},
): Promise<{ sessionId: string; socket: WebSocket }> {
  const socket = new WebSocket(`ws://127.0.0.1:${descriptor.port}/bridge`);
  await new Promise<void>((resolvePromise, reject) => {
    socket.once("open", resolvePromise);
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      method: "pair",
      token: overrides.token ?? descriptor.token,
      sessionNonce: descriptor.sessionNonce,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      productVersion: PRODUCT_VERSION,
      project: overrides.project ?? descriptor.project,
      addonManifestSha256,
      godotVersion: "4.7.stable.official.test",
    }),
  );

  return new Promise((resolvePromise, reject) => {
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message.method === "pair_rejected") {
        const error = new Error(String(message.message));
        Object.assign(error, { code: message.code });
        reject(error);
        return;
      }
      if (message.method === "pair_ok") {
        const sessionId = String(message.sessionId);
        const serverNonce = String(message.serverNonce);
        const expectedProof = createHmac("sha256", Buffer.from(descriptor.token, "base64url"))
          .update(`godot-mcp:server-proof:v1\n${sessionId}\n${serverNonce}`)
          .digest("hex");
        if (message.serverProof !== expectedProof) {
          reject(new Error("invalid server proof"));
          return;
        }
        const key = deriveSessionKey(descriptor.token, descriptor.sessionNonce, serverNonce);
        socket.send(
          JSON.stringify(
            signEnvelope(key, {
              sessionId,
              sequence: 1,
              deadlineUnixMs: Date.now() + 5_000,
              method: "pair.ack",
              params: { serverProof: expectedProof },
            }),
          ),
        );
        return;
      }
      if (message.method === "pair.complete") {
        resolvePromise({ sessionId: String(message.sessionId), socket });
      }
    });
    socket.once("close", () => {
      reject(Object.assign(new Error("pairing socket closed"), { code: "AUTHENTICATION_FAILED" }));
    });
    socket.once("error", reject);
  });
}

describe("bridge server", () => {
  it("pairs once and rejects a replayed token", async () => {
    const server = await startTestBridge();
    cleanups.push(server.close);
    const descriptor = await readDescriptor(server.descriptorPath);

    const first = await pairClient(descriptor);
    expect(first.sessionId).toMatch(/^session_/);
    expect((await server.waitForAttachment(1_000)).sessionId).toBe(first.sessionId);
    await expect(pairClient(descriptor)).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    first.socket.close();
  });

  it("rejects a wrong token", async () => {
    const server = await startTestBridge();
    cleanups.push(server.close);
    const descriptor = await readDescriptor(server.descriptorPath);

    await expect(pairClient(descriptor, { token: Buffer.alloc(32, 9).toString("base64url") })).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
  });

  it("rejects the wrong project and an expired descriptor", async () => {
    const projectServer = await startTestBridge();
    cleanups.push(projectServer.close);
    const descriptor = await readDescriptor(projectServer.descriptorPath);
    await expect(
      pairClient(descriptor, {
        project: { ...descriptor.project, projectConfigSha256: "b".repeat(64) },
      }),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });

    await projectServer.close();
    cleanups.pop();
    const expiredServer = await startTestBridge({ now: () => Date.now() + 61_000 });
    cleanups.push(expiredServer.close);
    const expiredDescriptor = await readDescriptor(expiredServer.descriptorPath);
    await expect(pairClient(expiredDescriptor)).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
  });

  it("rejects a pairing frame over one MiB", async () => {
    const server = await startTestBridge();
    cleanups.push(server.close);
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/bridge`);
    await new Promise<void>((resolvePromise, reject) => {
      socket.once("open", resolvePromise);
      socket.once("error", reject);
    });
    socket.send("x".repeat(1_048_577));
    const closeCode = await new Promise<number>((resolvePromise) => {
      socket.once("close", resolvePromise);
    });
    expect(closeCode).toBe(1009);
  });

  it("binds only to IPv4 loopback and closes idempotently", async () => {
    const server = await startTestBridge();
    expect(server.address).toMatchObject({ address: "127.0.0.1" });
    await server.close();
    await server.close();
  });
});
