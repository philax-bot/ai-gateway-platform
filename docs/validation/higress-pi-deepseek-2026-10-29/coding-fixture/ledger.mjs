function isSafeNonNegativeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function settle(balanceMicros, entries) {
  if (!isSafeNonNegativeInteger(balanceMicros)) {
    throw new Error("balanceMicros must be a non-negative safe integer");
  }
  if (!Array.isArray(entries)) {
    throw new Error("entries must be an array");
  }

  const seen = new Map();
  const accepted = [];

  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("malformed entry: expected an object");
    }

    const { id, amountMicros } = entry;

    if (typeof id !== "string" || id.length === 0) {
      throw new Error("malformed entry: id must be a non-empty string");
    }
    if (
      typeof amountMicros !== "number" ||
      !Number.isSafeInteger(amountMicros) ||
      amountMicros <= 0
    ) {
      throw new Error("malformed entry: amountMicros must be a positive safe integer");
    }

    if (seen.has(id)) {
      if (seen.get(id) !== amountMicros) {
        throw new Error(`conflicting duplicate entry for id "${id}"`);
      }
      // Exact duplicate (same id and amount) within one call: ignore it.
      continue;
    }

    seen.set(id, amountMicros);
    accepted.push(amountMicros);
  }

  let remaining = balanceMicros;
  for (const amountMicros of accepted) {
    if (amountMicros > remaining) {
      throw new Error("overdraft: insufficient balance");
    }
    remaining -= amountMicros;
  }

  return remaining;
}
