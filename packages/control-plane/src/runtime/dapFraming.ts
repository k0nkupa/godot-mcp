import { TextDecoder } from "node:util";

const HEADER_SEPARATOR = Buffer.from("\r\n\r\n", "ascii");
const MAX_HEADER_BYTES = 8 * 1024;
export const MAX_DAP_BODY_BYTES = 1024 * 1024;

export class DapProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DapProtocolError";
  }
}

export function encodeDapMessage(message: Readonly<Record<string, unknown>>): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.byteLength > MAX_DAP_BODY_BYTES) {
    throw new DapProtocolError("DAP message exceeds the one MiB body limit");
  }
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "ascii"),
    body,
  ]);
}

export class DapFrameParser {
  private buffer = Buffer.alloc(0);
  private expectedBodyBytes: number | null = null;

  push(chunk: Buffer): Array<Record<string, unknown>> {
    if (chunk.byteLength > 0) this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: Array<Record<string, unknown>> = [];
    while (true) {
      if (this.expectedBodyBytes === null) {
        const separatorIndex = this.buffer.indexOf(HEADER_SEPARATOR);
        if (separatorIndex < 0) {
          if (this.buffer.includes(Buffer.from("\n\n", "ascii"))) throw new DapProtocolError("DAP headers require CRLF line endings");
          if (this.buffer.byteLength > MAX_HEADER_BYTES) throw new DapProtocolError("DAP header exceeds 8 KiB");
          break;
        }
        if (separatorIndex > MAX_HEADER_BYTES) throw new DapProtocolError("DAP header exceeds 8 KiB");
        const header = this.buffer.subarray(0, separatorIndex).toString("ascii");
        this.buffer = this.buffer.subarray(separatorIndex + HEADER_SEPARATOR.byteLength);
        this.expectedBodyBytes = parseContentLength(header);
      }
      if (this.buffer.byteLength < this.expectedBodyBytes) break;
      const body = this.buffer.subarray(0, this.expectedBodyBytes);
      this.buffer = this.buffer.subarray(this.expectedBodyBytes);
      this.expectedBodyBytes = null;
      messages.push(parseBody(body));
    }
    return messages;
  }
}

function parseContentLength(header: string): number {
  const lines = header.split("\r\n");
  const lengths = lines.filter((line) => line.toLowerCase().startsWith("content-length:"));
  if (lengths.length !== 1 || lines.length !== 1) {
    throw new DapProtocolError("DAP header must contain exactly one Content-Length field");
  }
  const rawLength = lengths[0]!.slice(lengths[0]!.indexOf(":") + 1).trim();
  if (!/^[1-9][0-9]*$/.test(rawLength)) throw new DapProtocolError("DAP Content-Length is invalid");
  const length = Number(rawLength);
  if (!Number.isSafeInteger(length)) throw new DapProtocolError("DAP Content-Length is invalid");
  if (length > MAX_DAP_BODY_BYTES) throw new DapProtocolError("DAP body exceeds the one MiB limit");
  return length;
}

function parseBody(body: Buffer): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new DapProtocolError("DAP body is not valid UTF-8 JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DapProtocolError("DAP message must be a JSON object");
  }
  return value as Record<string, unknown>;
}
