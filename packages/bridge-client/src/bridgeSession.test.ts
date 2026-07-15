import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";

import { EnvelopeVerifier, signEnvelope } from "@godot-mcp/control-plane";
import type { BridgeEnvelope } from "@godot-mcp/protocol";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BridgeSession } from "./bridgeSession.js";

const key = Buffer.alloc(32, 7);
const sessionId = "session_1234567890";

interface TestPeer {
  server: WebSocketServer;
  client: WebSocket;
  session: BridgeSession;
  nextEnvelope(): Promise<BridgeEnvelope>;
  send(method: string, params: unknown): void;
  close(): Promise<void>;
}

async function createPeer(): Promise<TestPeer> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("listening", resolvePromise);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  const accepted = new Promise<WebSocket>((resolvePromise) => server.once("connection", resolvePromise));
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await new Promise<void>((resolvePromise, reject) => {
    client.once("open", resolvePromise);
    client.once("error", reject);
  });
  const serverSocket = await accepted;
  const session = new BridgeSession(serverSocket, key, new EnvelopeVerifier(key), {
    sessionId,
    project: {
      projectId: "019f644c-1379-79c0-825e-66a4b7653bd1",
      rootRealPath: "/tmp/project",
      projectConfigSha256: "a".repeat(64),
    },
    grants: { tiers: ["observe"], packs: ["core"] },
    godotVersion: "4.7.stable.official.test",
    addonManifestSha256: "b".repeat(64),
  });
  let sendSequence = 0;

  return {
    server,
    client,
    session,
    nextEnvelope(): Promise<BridgeEnvelope> {
      return new Promise((resolvePromise, reject) => {
        client.once("message", (data, isBinary) => {
          if (isBinary) reject(new Error("unexpected binary envelope"));
          else resolvePromise(JSON.parse(data.toString()) as BridgeEnvelope);
        });
        client.once("error", reject);
      });
    },
    send(method: string, params: unknown): void {
      sendSequence += 1;
      client.send(
        JSON.stringify(
          signEnvelope(key, {
            sessionId,
            sequence: sendSequence,
            deadlineUnixMs: Date.now() + 5_000,
            method,
            params,
          }),
        ),
      );
    },
    async close(): Promise<void> {
      await session.close().catch(() => undefined);
      client.terminate();
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}

let peer: TestPeer;

beforeEach(async () => {
  peer = await createPeer();
});

afterEach(async () => {
  await peer.close();
});

describe("BridgeSession requests", () => {
  it("correlates the closed runtime editor commands", async () => {
    for (const method of ["runtime.prepare", "runtime.command", "runtime.capture", "runtime.cleanup"] as const) {
      const request = peer.session.request<{ accepted: boolean }>(method, {}, { timeoutMs: 1_000 });
      const sent = await peer.nextEnvelope();
      const requestId = String((sent.params as { requestId: string }).requestId);
      peer.send("command.result", { requestId, ok: true, data: { accepted: true } });
      await expect(request).resolves.toMatchObject({ data: { accepted: true } });
    }
  });

  it("correlates a command result", async () => {
    const request = peer.session.request<{ state: string }>(
      "editor.query",
      { operation: "editor_state" },
      { timeoutMs: 1_000 },
    );
    const sent = await peer.nextEnvelope();
    const requestId = String((sent.params as { requestId: string }).requestId);
    peer.send("command.result", { requestId, ok: true, data: { state: "ready" } });

    await expect(request).resolves.toMatchObject({ requestId, data: { state: "ready" } });
  });

  it("assembles contiguous chunks and verifies size and digest", async () => {
    const first = Buffer.from("chunk-a");
    const second = Buffer.from("chunk-b");
    const png = Buffer.concat([first, second]);
    const sha256 = createHash("sha256").update(png).digest("hex");
    const request = peer.session.request<{ mimeType: string }>(
      "editor.capture",
      { viewport: "2d" },
      { timeoutMs: 1_000, maxResponseBytes: 1_024 },
    );
    const sent = await peer.nextEnvelope();
    const requestId = String((sent.params as { requestId: string }).requestId);
    peer.send("command.chunk", {
      requestId,
      index: 0,
      total: 2,
      sha256,
      data: first.toString("base64url"),
    });
    peer.send("command.chunk", {
      requestId,
      index: 1,
      total: 2,
      sha256,
      data: second.toString("base64url"),
    });
    peer.send("command.result", {
      requestId,
      ok: true,
      data: { mimeType: "image/png" },
      binary: { size: png.length, sha256, chunks: 2 },
    });

    const result = await request;
    expect(result.binarySha256).toBe(sha256);
    expect(Buffer.from(result.binary ?? [])).toEqual(png);
  });

  it("rejects out-of-order chunks", async () => {
    const bytes = Buffer.from("chunk");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const request = peer.session.request("editor.capture", {}, { timeoutMs: 1_000 });
    const sent = await peer.nextEnvelope();
    const requestId = String((sent.params as { requestId: string }).requestId);
    peer.send("command.chunk", {
      requestId,
      index: 1,
      total: 2,
      sha256,
      data: bytes.toString("base64url"),
    });

    await expect(request).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("rejects chunk streams over the request response limit", async () => {
    const bytes = Buffer.from("larger-than-limit");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const request = peer.session.request("editor.capture", {}, {
      timeoutMs: 1_000,
      maxResponseBytes: 8,
    });
    const sent = await peer.nextEnvelope();
    const requestId = String((sent.params as { requestId: string }).requestId);
    peer.send("command.chunk", {
      requestId,
      index: 0,
      total: 1,
      sha256,
      data: bytes.toString("base64url"),
    });

    await expect(request).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("rejects a chunk stream whose declared digest does not match its bytes", async () => {
    const bytes = Buffer.from("chunk");
    const wrongSha256 = "c".repeat(64);
    const request = peer.session.request("editor.capture", {}, { timeoutMs: 1_000 });
    const sent = await peer.nextEnvelope();
    const requestId = String((sent.params as { requestId: string }).requestId);
    peer.send("command.chunk", {
      requestId,
      index: 0,
      total: 1,
      sha256: wrongSha256,
      data: bytes.toString("base64url"),
    });
    peer.send("command.result", {
      requestId,
      ok: true,
      data: {},
      binary: { size: bytes.length, sha256: wrongSha256, chunks: 1 },
    });

    await expect(request).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("rejects pending requests on timeout and disconnect", async () => {
    await expect(
      peer.session.request("editor.query", {}, { timeoutMs: 5 }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });

    const pending = peer.session.request("editor.query", {}, { timeoutMs: 1_000 });
    await peer.nextEnvelope();
    peer.client.close();
    await expect(pending).rejects.toMatchObject({ code: "NOT_ATTACHED" });
  });
});
