import { execSync } from "node:child_process";

export function resolveSecrets<T>(obj: T): T {
  if (typeof obj === "string") return resolveString(obj) as unknown as T;
  if (Array.isArray(obj)) return obj.map((v) => resolveSecrets(v)) as unknown as T;
  if (obj !== null && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = resolveSecrets(v);
    }
    return out as T;
  }
  return obj;
}

function resolveString(value: string): string {
  const doppler = value.match(/^\$DOPPLER:(.+)$/);
  if (doppler) {
    const name = doppler[1]!;
    try {
      return execSync(`doppler secrets get ${name} --plain 2>/dev/null`, {
        encoding: "utf8",
      }).trim();
    } catch {
      // fall through to env var
    }
    const env = process.env[name];
    if (env === undefined)
      throw new Error(
        `Secret not resolved: $DOPPLER:${name} — Doppler unavailable and env var ${name} not set`,
      );
    return env;
  }

  const envRef = value.match(/^\$ENV:(.+)$/);
  if (envRef) {
    const name = envRef[1]!;
    const env = process.env[name];
    if (env === undefined) throw new Error(`Env var not set: ${name}`);
    return env;
  }

  return value;
}
