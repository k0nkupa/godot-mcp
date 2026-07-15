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
