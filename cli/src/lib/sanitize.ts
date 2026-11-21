/**
 * Replaces secret-looking values in pulled resource configs with `$ENV:NAME`
 * references so they are never written to disk (and thus never committed).
 * The real values are returned separately so state hashes can still be
 * computed from the resolved config (which is what `plan` hashes).
 */

const SECRET_KEY = /secret|token|password|passwd|key|credential(?!id)/i;

export interface Sanitized {
  /** Config with secret values replaced by `$ENV:NAME` references. */
  config: Record<string, unknown>;
  /** Env var name → real value, for every value that was replaced. */
  env: Record<string, string>;
}

export function envVarName(...parts: string[]): string {
  return parts
    .join("_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

export function sanitizeConfig(
  resourceName: string,
  config: Record<string, unknown>,
  opts: { maskAllVariables?: boolean } = {},
): Sanitized {
  const env: Record<string, string> = {};

  const walk = (node: unknown, path: string[], forceMask: boolean): unknown => {
    if (Array.isArray(node)) return node.map((v, i) => walk(v, [...path, String(i)], forceMask));
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        // http credentials keep their secrets in `variables`: mask all of them.
        const mask = forceMask || (opts.maskAllVariables === true && path.at(-1) === "variables");
        out[k] = walk(v, [...path, k], mask);
      }
      return out;
    }
    if (typeof node === "string" && node !== "" && !node.startsWith("$")) {
      const leaf = path.at(-1) ?? "";
      if (forceMask || SECRET_KEY.test(leaf)) {
        const name = envVarName(resourceName, ...path.filter((p) => p !== "config"));
        env[name] = node;
        return `$ENV:${name}`;
      }
    }
    return node;
  };

  return { config: walk(config, [], false) as Record<string, unknown>, env };
}
