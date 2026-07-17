type CanonicalValue = null | boolean | number | string | CanonicalValue[] | { [key: string]: CanonicalValue };

function normalize(value: unknown, ancestors: Set<object>): CanonicalValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new TypeError("Canonical JSON v1 accepts only finite safe integers");
    }
    return Object.is(value, -0) ? 0 : value;
  }

  if (
    value === undefined ||
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    throw new TypeError(`Canonical JSON v1 does not support ${typeof value}`);
  }

  if (ancestors.has(value)) {
    throw new TypeError("Canonical JSON v1 does not support cyclic values");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const normalized: CanonicalValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new TypeError("Canonical JSON v1 does not support sparse arrays");
        }
        normalized.push(normalize(value[index], ancestors));
      }
      return normalized;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON v1 accepts only arrays and plain objects");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError("Canonical JSON v1 does not support symbol keys");
    }

    const normalized: { [key: string]: CanonicalValue } = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalize((value as Record<string, unknown>)[key], ancestors);
    }
    return normalized;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, new Set<object>()));
}

export function canonicalFloat64Le(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError("Float64 canonical encoding requires a finite number");
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function decodeFloat64Le(value: string): number {
  if (!/^[a-f0-9]{16}$/.test(value)) throw new TypeError("Float64 canonical encoding must be 16 lowercase hex characters");
  const bytes = Uint8Array.from(value.match(/../g)!.map((pair) => Number.parseInt(pair, 16)));
  const decoded = new DataView(bytes.buffer).getFloat64(0, true);
  if (!Number.isFinite(decoded)) throw new TypeError("Float64 canonical encoding must decode to a finite number");
  return decoded;
}
