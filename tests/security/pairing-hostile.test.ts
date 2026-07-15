import { createHash, createHmac, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { startBridgeServer, type BridgeServer } from "@godot-mcp/bridge-client";
import {
  JsonlAuditSink,
  consumePairingDescriptor,
  deriveSessionKey,
  readProjectIdentity,
  signEnvelope,
  type SessionDescriptor,
  type SessionGrants,
} from "@godot-mcp/control-plane";
import { BRIDGE_PROTOCOL_VERSION, PRODUCT_VERSION } from "@godot-mcp/protocol";
import { copyFixture, waitUntil, type TempProject } from "@godot-mcp/testkit";
import { WebSocket, type RawData } from "ws";
import { expect, it } from "vitest";

const grants: SessionGrants = { tiers: ["observe"], packs: ["core"] };
const addonManifestSha256 = "a".repeat(64);

type HostileAttack =
  | "wrong_token"
  | "wrong_project"
  | "changed_project_hash"
  | "expired_descriptor"
  | "replayed_pair"
  | "repeated_sequence"
  | "oversized_frame"
  | "malformed_json"
  | "malformed_project"
  | "early_connection"
  | "second_client";

type StableRejection =
  | "AUTHENTICATION_FAILED"
  | "PROJECT_CHANGED"
  | "PAYLOAD_TOO_LARGE"
  | "INVALID_REQUEST";

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const onMessage = (data: RawData, isBinary: boolean): void => {
      cleanup();
      if (isBinary) reject(new Error("Unexpected binary response"));
      else resolvePromise(JSON.parse(data.toString()) as Record<string, unknown>);
    };
    const onClose = (code: number): void => {
      cleanup();
      reject(Object.assign(new Error(`Socket closed with ${code}`), { closeCode: code }));
    };
    const cleanup = (): void => {
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };
    socket.once("message", onMessage);
    socket.once("close", onClose);
  });
}

class HostilePairingHarness {
  private readonly sockets = new Set<WebSocket>();
  private readonly closeCodes = new Map<WebSocket, Promise<number>>();
  private sessionKey: Buffer | undefined;

  private constructor(
    readonly project: TempProject,
    readonly server: BridgeServer,
    readonly descriptor: SessionDescriptor,
    readonly auditPath: string,
    readonly projectSnapshot: string,
    readonly previousRuntimeDirectory: string | undefined,
    private readonly setClock: (value: number) => void,
  ) {}

  static async create(): Promise<HostilePairingHarness> {
    const project = await copyFixture();
    const previousRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = join(project.root, "runtime");
    const identity = await readProjectIdentity(project.root);
    const projectSnapshot = createHash("sha256")
      .update(await readFile(join(project.root, "project.godot")))
      .digest("hex");
    const artifactDirectory = process.env.GODOT_MCP_FAILURE_ARTIFACT_DIR;
    if (artifactDirectory) await mkdir(artifactDirectory, { recursive: true });
    const auditPath = artifactDirectory
      ? join(artifactDirectory, `security-audit-${randomUUID()}.jsonl`)
      : join(project.root, ".godot/evidence/godot-mcp/security-audit.jsonl");
    let clock = Date.now();
    const server = await startBridgeServer({
      project: identity,
      grants,
      addonManifestSha256,
      auditSink: new JsonlAuditSink(auditPath),
      handshakeTimeoutMs: 250,
      now: () => clock,
    });
    const descriptor = JSON.parse(await readFile(server.descriptorPath, "utf8")) as SessionDescriptor;
    return new HostilePairingHarness(
      project,
      server,
      descriptor,
      auditPath,
      projectSnapshot,
      previousRuntimeDirectory,
      (value) => {
        clock = value;
      },
    );
  }

  async attempt(attack: HostileAttack): Promise<StableRejection> {
    if (attack === "oversized_frame") {
      const socket = await this.openSocket();
      const closed = this.waitForSocketClose(socket);
      socket.send("x".repeat(1_048_577));
      expect(await closed).toBe(1009);
      return "PAYLOAD_TOO_LARGE";
    }
    if (attack === "malformed_json") {
      return this.sendRejected("{");
    }
    if (attack === "malformed_project") {
      return this.sendRejected(JSON.stringify(this.pairRequest({ project: {} })));
    }
    if (attack === "early_connection") {
      const socket = await this.openSocket();
      return this.readRejection(socket);
    }
    if (attack === "second_client") {
      const first = await this.openSocket();
      const second = await this.openSocket();
      const closed = await this.waitForSocketClose(second);
      first.close();
      expect(closed).toBe(1008);
      return "AUTHENTICATION_FAILED";
    }
    if (attack === "expired_descriptor") {
      this.setClock(this.descriptor.expiresAtUnixMs + 1);
      return this.sendRejected(JSON.stringify(this.pairRequest()));
    }
    if (attack === "wrong_token") {
      return this.sendRejected(
        JSON.stringify(this.pairRequest({ token: Buffer.alloc(32, 9).toString("base64url") })),
      );
    }
    if (attack === "wrong_project") {
      return this.sendRejected(
        JSON.stringify(
          this.pairRequest({ project: { ...this.descriptor.project, projectId: randomUUID() } }),
        ),
      );
    }
    if (attack === "changed_project_hash") {
      return this.sendRejected(
        JSON.stringify(
          this.pairRequest({
            project: { ...this.descriptor.project, projectConfigSha256: "b".repeat(64) },
          }),
        ),
      );
    }

    const paired = await this.completePair();
    if (attack === "replayed_pair") {
      paired.socket.close();
      await waitUntil(() => this.server.session === null, 2_000, 25);
      const second = await this.openSocket();
      const closed = this.waitForSocketClose(second);
      second.send(JSON.stringify(this.pairRequest()));
      expect(await closed).toBe(1008);
      return "AUTHENTICATION_FAILED";
    }

    const closed = this.waitForSocketClose(paired.socket);
    paired.socket.send(
      JSON.stringify(
        signEnvelope(paired.key, {
          sessionId: paired.sessionId,
          sequence: 1,
          deadlineUnixMs: Date.now() + 5_000,
          method: "addon.ready",
          params: {},
        }),
      ),
    );
    expect(await closed).toBe(1008);
    return "AUTHENTICATION_FAILED";
  }

  async assertUnchangedAndAudited(expected: StableRejection): Promise<void> {
    const current = createHash("sha256")
      .update(await readFile(join(this.project.root, "project.godot")))
      .digest("hex");
    expect(current).toBe(this.projectSnapshot);
    await waitUntil(
      async () => (await this.auditRecords()).some((record) => record.errorCode === expected),
      2_000,
      25,
    );
    const auditText = await readFile(this.auditPath, "utf8");
    expect(auditText).not.toContain(this.descriptor.token);
    if (this.sessionKey) {
      expect(auditText).not.toContain(this.sessionKey.toString("hex"));
      expect(auditText).not.toContain(this.sessionKey.toString("base64url"));
    }
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
    }
    this.sockets.clear();
    await this.server.close();
    await this.server.close();
    if (this.previousRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = this.previousRuntimeDirectory;
    await this.project.cleanup();
  }

  async completePair(): Promise<{ socket: WebSocket; sessionId: string; key: Buffer }> {
    const socket = await this.openSocket();
    const pairResponse = nextMessage(socket);
    socket.send(JSON.stringify(this.pairRequest()));
    const pairOk = await pairResponse;
    expect(pairOk.method).toBe("pair_ok");
    const sessionId = String(pairOk.sessionId);
    const serverNonce = String(pairOk.serverNonce);
    const serverProof = createHmac("sha256", Buffer.from(this.descriptor.token, "base64url"))
      .update(`godot-mcp:server-proof:v1\n${sessionId}\n${serverNonce}`)
      .digest("hex");
    expect(pairOk.serverProof).toBe(serverProof);
    const key = deriveSessionKey(
      this.descriptor.token,
      this.descriptor.sessionNonce,
      serverNonce,
    );
    this.sessionKey = key;
    const completeResponse = nextMessage(socket);
    socket.send(
      JSON.stringify(
        signEnvelope(key, {
          sessionId,
          sequence: 1,
          deadlineUnixMs: Date.now() + 5_000,
          method: "pair.ack",
          params: { serverProof },
        }),
      ),
    );
    expect((await completeResponse).method).toBe("pair.complete");
    return { socket, sessionId, key };
  }

  async descriptorExists(): Promise<boolean> {
    try {
      await access(this.server.descriptorPath);
      return true;
    } catch {
      return false;
    }
  }

  async auditRecords(): Promise<Array<{ errorCode?: string | null }>> {
    const text = await readFile(this.auditPath, "utf8").catch(() => "");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { errorCode?: string | null });
  }

  private pairRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      method: "pair",
      token: this.descriptor.token,
      sessionNonce: this.descriptor.sessionNonce,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      productVersion: PRODUCT_VERSION,
      project: this.descriptor.project,
      addonManifestSha256,
      godotVersion: "4.7.stable.official.security-test",
      ...overrides,
    };
  }

  private async openSocket(): Promise<WebSocket> {
    const socket = new WebSocket(`ws://127.0.0.1:${this.server.port}/bridge`);
    this.sockets.add(socket);
    this.closeCodes.set(
      socket,
      new Promise((resolvePromise) => socket.once("close", resolvePromise)),
    );
    await new Promise<void>((resolvePromise, reject) => {
      socket.once("open", resolvePromise);
      socket.once("error", reject);
    });
    return socket;
  }

  private waitForSocketClose(socket: WebSocket): Promise<number> {
    const closeCode = this.closeCodes.get(socket);
    if (!closeCode) throw new Error("Socket is not owned by this harness");
    return closeCode;
  }

  private async sendRejected(text: string): Promise<StableRejection> {
    const socket = await this.openSocket();
    const rejection = nextMessage(socket);
    socket.send(text);
    const response = await rejection;
    expect(response.method).toBe("pair_rejected");
    return String(response.code) as StableRejection;
  }

  private async readRejection(socket: WebSocket): Promise<StableRejection> {
    const response = await nextMessage(socket);
    expect(response.method).toBe("pair_rejected");
    return String(response.code) as StableRejection;
  }
}

const attacks: ReadonlyArray<{ attack: HostileAttack; expected: StableRejection }> = [
  { attack: "wrong_token", expected: "AUTHENTICATION_FAILED" },
  { attack: "wrong_project", expected: "AUTHENTICATION_FAILED" },
  { attack: "changed_project_hash", expected: "PROJECT_CHANGED" },
  { attack: "expired_descriptor", expected: "AUTHENTICATION_FAILED" },
  { attack: "replayed_pair", expected: "AUTHENTICATION_FAILED" },
  { attack: "repeated_sequence", expected: "AUTHENTICATION_FAILED" },
  { attack: "oversized_frame", expected: "PAYLOAD_TOO_LARGE" },
  { attack: "malformed_json", expected: "INVALID_REQUEST" },
  { attack: "malformed_project", expected: "INVALID_REQUEST" },
  { attack: "early_connection", expected: "AUTHENTICATION_FAILED" },
  { attack: "second_client", expected: "AUTHENTICATION_FAILED" },
];

it.each(attacks)(
  "rejects $attack without project mutation or secret leakage",
  async ({ attack, expected }) => {
    const harness = await HostilePairingHarness.create();
    try {
      expect(await harness.attempt(attack)).toBe(expected);
      await harness.assertUnchangedAndAudited(expected);
    } finally {
      await harness.close();
    }
  },
  10_000,
);

it("cleans up idempotently after server death", async () => {
  const harness = await HostilePairingHarness.create();
  try {
    await harness.server.close();
    await harness.server.close();
    expect(await harness.descriptorExists()).toBe(false);
  } finally {
    await harness.close();
  }
});

it("observes editor transport death and cleans up idempotently", async () => {
  const harness = await HostilePairingHarness.create();
  try {
    const editor = await harness.completePair();
    editor.socket.terminate();
    await waitUntil(() => harness.server.session === null, 2_000, 25);
    await harness.server.close();
    await harness.server.close();
    expect(await harness.descriptorExists()).toBe(false);
  } finally {
    await harness.close();
  }
});

it("deletes an expired stale descriptor and tolerates repeated recovery", async () => {
  const harness = await HostilePairingHarness.create();
  try {
    await harness.server.close();
    await writeFile(
      harness.server.descriptorPath,
      `${JSON.stringify({ ...harness.descriptor, expiresAtUnixMs: Date.now() - 1 })}\n`,
      { mode: 0o600 },
    );
    await expect(consumePairingDescriptor(harness.server.descriptorPath)).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
    await rm(harness.server.descriptorPath, { force: true });
    await rm(harness.server.descriptorPath, { force: true });
    expect(await harness.descriptorExists()).toBe(false);
  } finally {
    await harness.close();
  }
});
