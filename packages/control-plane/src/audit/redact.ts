const SECRET_KEY = /token|secret|password|authorization|cookie|private[_-]?key/i;

function binaryLength(value: unknown): number | undefined {
  if (Buffer.isBuffer(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return undefined;
}

function redact(value: unknown, ancestors: Set<object>): unknown {
  const bytes = binaryLength(value);
  if (bytes !== undefined) return `[BINARY ${bytes} bytes]`;
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (value === undefined) return "[UNDEFINED]";
  if (["bigint", "function", "symbol"].includes(typeof value)) {
    return `[${(typeof value).toUpperCase()}]`;
  }

  const objectValue = value as object;
  if (ancestors.has(objectValue)) return "[CIRCULAR]";
  ancestors.add(objectValue);
  try {
    if (Array.isArray(value)) return value.map((item) => redact(item, ancestors));
    if (value instanceof Date) return value.toISOString();

    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redact(item, ancestors);
    }
    return output;
  } finally {
    ancestors.delete(objectValue);
  }
}

export function redactAuditValue(value: unknown): unknown {
  return redact(value, new Set<object>());
}
