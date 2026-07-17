import { createServer, type Server, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { DapClient, DapClientError } from "./dapClient.js";
import { DapFrameParser, encodeDapMessage } from "./dapFraming.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fakeDapServer(
  onMessage: (message: Record<string, unknown>, socket: Socket) => void,
): Promise<{ port: number; server: Server }> {
  const server = createServer((socket) => {
    const parser = new DapFrameParser();
    socket.on("data", (chunk) => {
      for (const message of parser.push(chunk)) onMessage(message, socket);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fake DAP server did not bind a TCP port");
  cleanups.push(async () => new Promise<void>((resolve) => server.close(() => resolve())));
  return { port: address.port, server };
}

function response(request: Record<string, unknown>, body: Record<string, unknown> = {}) {
  return {
    seq: Number(request.seq) + 100,
    type: "response",
    request_seq: request.seq,
    success: true,
    command: request.command,
    body,
  };
}

describe("closed-world Godot DAP client", () => {
  it("serializes requests and correlates responses", async () => {
    const received: string[] = [];
    const { port } = await fakeDapServer((message, socket) => {
      received.push(String(message.command));
      socket.write(encodeDapMessage(response(message, { echoed: message.command })));
    });
    const client = await DapClient.connect({ host: "127.0.0.1", port });
    cleanups.push(() => client.close());

    const first = client.request("initialize", { linesStartAt1: true }, 1_000);
    const second = client.request("attach", { project: "/tmp/project" }, 1_000);
    await expect(first).resolves.toMatchObject({ body: { echoed: "initialize" } });
    await expect(second).resolves.toMatchObject({ body: { echoed: "attach" } });
    expect(received).toEqual(["initialize", "attach"]);
  });

  it("rejects commands outside the explicit allowlist without writing them", async () => {
    let received = 0;
    const { port } = await fakeDapServer(() => { received += 1; });
    const client = await DapClient.connect({ host: "127.0.0.1", port });
    cleanups.push(() => client.close());
    await expect(client.request("evaluate" as never, { expression: "quit()" }, 1_000))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(received).toBe(0);
  });

  it("returns ordered stopped events and tracks continued state", async () => {
    const { port } = await fakeDapServer((message, socket) => {
      socket.write(encodeDapMessage(response(message)));
      socket.write(encodeDapMessage({ seq: 91, type: "event", event: "stopped", body: { reason: "breakpoint", threadId: 1 } }));
      socket.write(encodeDapMessage({ seq: 92, type: "event", event: "continued", body: { threadId: 1 } }));
    });
    const client = await DapClient.connect({ host: "127.0.0.1", port });
    cleanups.push(() => client.close());
    await client.request("attach", { project: "/tmp/project" }, 1_000);
    await expect(client.nextStop(0, 1_000)).resolves.toMatchObject({ sequence: 1, reason: "breakpoint", body: { threadId: 1 } });
    expect(client.snapshot()).toMatchObject({ connected: true, stopped: false, stopSequence: 1 });
  });

  it("times out one request and remains closed to late response reassignment", async () => {
    let firstRequest: Record<string, unknown> | undefined;
    const { port } = await fakeDapServer((message, socket) => {
      if (!firstRequest) {
        firstRequest = message;
        setTimeout(() => socket.write(encodeDapMessage(response(message))), 50);
        return;
      }
      socket.write(encodeDapMessage(response(message)));
    });
    const client = await DapClient.connect({ host: "127.0.0.1", port });
    cleanups.push(() => client.close());
    await expect(client.request("threads", {}, 10)).rejects.toMatchObject({ code: "TIMEOUT" });
    await expect(client.request("threads", {}, 1_000)).rejects.toBeInstanceOf(DapClientError);
    expect(firstRequest).toBeDefined();
  });

  it("fails closed on unknown response IDs and rejects pending waits on close", async () => {
    const { port } = await fakeDapServer((message, socket) => {
      socket.write(encodeDapMessage({ ...response(message), request_seq: 999_999 }));
    });
    const client = await DapClient.connect({ host: "127.0.0.1", port });
    const pendingStop = client.nextStop(0, 5_000);
    await expect(client.request("threads", {}, 1_000)).rejects.toMatchObject({ code: "TRANSPORT_ERROR" });
    await expect(pendingStop).rejects.toMatchObject({ code: "TRANSPORT_ERROR" });
    await client.close();
  });
});
