/**
 * Small checked accessors for untrusted JSON from a provider stream.
 *
 * Each narrows with a real `typeof` check and returns a typed-or-undefined value, so reading a
 * field from a model API response is verified rather than asserted. Cheaper than a full schema
 * for the deeply-nested, provider-specific streaming shapes, and it keeps the unchecked surface
 * to these four functions instead of scattering casts at every access.
 */

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Parse JSON text, returning a record when it is an object and undefined otherwise. */
export function parseRecord(text: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}
