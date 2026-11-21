import { createHash } from "node:crypto";

export function hashConfig(obj: unknown): string {
  const canonical = JSON.stringify(sortedKeys(obj));
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function sortedKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sortedKeys);
  if (obj !== null && typeof obj === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj as object).sort()) {
      sorted[key] = sortedKeys((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return obj;
}
