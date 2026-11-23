import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Long text fields (SQL, dashboard JSX) can live in their own files so editors
 * highlight them. In the YAML a field is replaced by a reference:
 *
 *   sql            ← sql_file: enrich.sql                (transform, saved-query)
 *   artifact_source← artifact_file: artifact.jsx         (dashboard)
 *   queries        ← query_files: [query-1.sql, ...]     (dashboard)
 *
 * References are relative to the YAML file. Discovery inlines the contents, so
 * the rest of the CLI (hashing, planning, API calls) only sees the inline form
 * and a resource hashes the same whichever way it is written.
 */

/** Trailing whitespace is not significant (editors add a final newline). */
export function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").trimEnd();
}

export function readExternal(yamlAbs: string, ref: unknown, field: string): string {
  if (typeof ref !== "string" || !ref) {
    throw new Error(`${field} must be a file path (in ${yamlAbs})`);
  }
  const abs = resolve(dirname(yamlAbs), ref);
  if (!existsSync(abs)) {
    throw new Error(`${field}: file not found: ${ref} (referenced from ${yamlAbs})`);
  }
  return normalizeText(readFileSync(abs, "utf8"));
}

/** Replace `<file>` reference fields in a parsed YAML object with inline content. */
export function inlineExternalFiles(
  parsed: Record<string, unknown>,
  yamlAbs: string,
): Record<string, unknown> {
  const out = { ...parsed };
  const single = (fileKey: string, inlineKey: string) => {
    if (out[fileKey] === undefined) return;
    if (out[inlineKey] !== undefined) {
      throw new Error(`Set only one of '${inlineKey}' and '${fileKey}' (in ${yamlAbs})`);
    }
    out[inlineKey] = readExternal(yamlAbs, out[fileKey], fileKey);
    delete out[fileKey];
  };

  if (out.kind === "transform" || out.kind === "saved-query") single("sql_file", "sql");
  if (out.kind === "dashboard") {
    single("artifact_file", "artifact_source");
    if (out.query_files !== undefined) {
      if (out.queries !== undefined) {
        throw new Error(`Set only one of 'queries' and 'query_files' (in ${yamlAbs})`);
      }
      if (!Array.isArray(out.query_files)) {
        throw new Error(`query_files must be a list of file paths (in ${yamlAbs})`);
      }
      out.queries = out.query_files.map((f) => readExternal(yamlAbs, f, "query_files"));
      out.query_files = undefined;
    }
  }
  return out;
}

/** Write `content` to `fileName` (relative to the YAML file) with a final newline. */
export function writeSidecar(yamlAbs: string, fileName: string, content: string): void {
  const abs = resolve(dirname(yamlAbs), fileName);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${normalizeText(content)}\n`);
}

const NAME_MARKER = /^\s*--\s*name:\s*([A-Za-z0-9_-]+)\s*$/;

/**
 * Dashboard queries have no names in the API (the artifact reads them by index),
 * so a query can name itself with a leading `-- name: foo` comment. It is part of
 * the SQL string, so it round-trips through the API untouched.
 */
export function parseQueryName(sql: string): string | null {
  const first = sql.split("\n").find((l) => l.trim() !== "");
  return first?.match(NAME_MARKER)?.[1] ?? null;
}

/** File names for a dashboard's queries: marker, else main FROM table, else query-N. */
export function queryFileNames(queries: string[]): string[] {
  const used = new Set<string>();
  return queries.map((sql, i) => {
    const base =
      parseQueryName(sql) ??
      sql
        .replace(/--.*$/gm, "")
        .match(/\bFROM\s+["`]?([A-Za-z_]\w*)/i)?.[1]
        ?.replace(/_/g, "-") ??
      `query-${i + 1}`;
    let name = base.toLowerCase();
    for (let n = 2; used.has(name); n++) name = `${base.toLowerCase()}-${n}`;
    used.add(name);
    return `${name}.sql`;
  });
}
