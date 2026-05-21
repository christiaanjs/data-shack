import { decryptConfig } from "./crypto.ts";

export function resolveHeaderTemplates(
  headers: Record<string, string>,
  variables: Record<string, string>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    resolved[key] = value.replace(/\{\{(\w+)\}\}/g, (_, name) => variables[name] ?? "");
  }
  return resolved;
}

export async function decryptHttpConfig(
  encryptedConfig: string,
  jwtSecret: string,
): Promise<{
  baseUrl: string;
  headers: Record<string, string>;
  variables: Record<string, string>;
} | null> {
  try {
    const raw = JSON.parse(await decryptConfig(encryptedConfig, jwtSecret)) as Record<
      string,
      unknown
    >;
    if (typeof raw.baseUrl !== "string") return null;
    let parsed: URL;
    try {
      parsed = new URL(raw.baseUrl);
    } catch {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

    const headers: Record<string, string> = {};
    if (typeof raw.headers === "object" && raw.headers !== null) {
      for (const [k, v] of Object.entries(raw.headers as Record<string, unknown>)) {
        if (typeof v === "string") headers[k] = v;
      }
    }
    const variables: Record<string, string> = {};
    if (typeof raw.variables === "object" && raw.variables !== null) {
      for (const [k, v] of Object.entries(raw.variables as Record<string, unknown>)) {
        if (typeof v === "string") variables[k] = v;
      }
    }
    return { baseUrl: raw.baseUrl, headers, variables };
  } catch {
    return null;
  }
}
