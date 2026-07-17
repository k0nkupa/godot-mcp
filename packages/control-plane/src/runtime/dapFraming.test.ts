import { describe, expect, it } from "vitest";

import { DapFrameParser, DapProtocolError, encodeDapMessage } from "./dapFraming.js";

describe("DAP Content-Length framing", () => {
  it("parses fragmented and coalesced frames", () => {
    const parser = new DapFrameParser();
    expect(parser.push(Buffer.from("Content-Length: 16\r\n\r\n{\"type\":\"event\""))).toEqual([]);
    expect(parser.push(Buffer.from("}"))).toEqual([{ type: "event" }]);

    const first = encodeDapMessage({ seq: 1, type: "event", event: "continued" });
    const second = encodeDapMessage({ seq: 2, type: "event", event: "terminated" });
    expect(parser.push(Buffer.concat([first, second]))).toEqual([
      { seq: 1, type: "event", event: "continued" },
      { seq: 2, type: "event", event: "terminated" },
    ]);
  });

  it("uses UTF-8 byte length when encoding", () => {
    const encoded = encodeDapMessage({ type: "event", event: "output", body: { output: "✓" } });
    const separator = encoded.indexOf("\r\n\r\n");
    const header = encoded.subarray(0, separator).toString("ascii");
    const body = encoded.subarray(separator + 4);
    expect(header).toBe(`Content-Length: ${body.byteLength}`);
    expect(JSON.parse(body.toString("utf8"))).toMatchObject({ body: { output: "✓" } });
  });

  it.each([
    "\r\n\r\n{}",
    "Content-Length: nope\r\n\r\n{}",
    "Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}",
    "content-length: 2\n\n{}",
  ])("rejects malformed headers", (frame) => {
    expect(() => new DapFrameParser().push(Buffer.from(frame))).toThrow(DapProtocolError);
  });

  it("rejects oversized bodies before buffering them", () => {
    expect(() => new DapFrameParser().push(Buffer.from(`Content-Length: ${1024 * 1024 + 1}\r\n\r\n`))).toThrow(/one MiB/i);
  });

  it("rejects invalid JSON and non-object messages", () => {
    expect(() => new DapFrameParser().push(Buffer.from("Content-Length: 1\r\n\r\n{"))).toThrow(/JSON/i);
    expect(() => new DapFrameParser().push(Buffer.from("Content-Length: 2\r\n\r\n[]"))).toThrow(/object/i);
  });
});
