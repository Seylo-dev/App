// Replaces sensitive fields before a value leaves the op pipeline for the
// audit log, an approval request or a model transcript.

export const redactedValue = "[redacted]";

/**
 * Returns a deep copy of `value` with every field matched by `paths` set to
 * "[redacted]". Paths are dotted; `*` matches any array index or object
 * key. Missing fields are left missing, so redaction never invents data.
 */
export function redact<T>(value: T, paths: readonly string[] | undefined): T {
  const copy = structuredClone(value);
  for (const path of paths ?? []) {
    redactPath(copy, path.split("."));
  }
  return copy;
}

function redactPath(node: unknown, segments: string[]): void {
  if (typeof node !== "object" || node === null || segments.length === 0) return;
  const [head, ...rest] = segments as [string, ...string[]];
  const record = node as Record<string, unknown>;
  const keys = head === "*" ? Object.keys(record) : Object.hasOwn(record, head) ? [head] : [];
  for (const key of keys) {
    if (rest.length === 0) {
      if (record[key] !== undefined) record[key] = redactedValue;
    } else {
      redactPath(record[key], rest);
    }
  }
}
