import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import yaml from "js-yaml";
import { inlineExternalFiles } from "./external-files.js";
import type { Resource } from "./types.js";

const RESOURCE_DIRS = ["data-sources", "transforms", "catalog", "dashboards"];

export interface ResourceFile {
  path: string;
  resource: Resource;
}

export function discoverResources(cwd = process.cwd()): ResourceFile[] {
  const results: ResourceFile[] = [];
  for (const dir of RESOURCE_DIRS) {
    const abs = resolve(cwd, dir);
    if (existsSync(abs)) walk(abs, results, cwd);
  }
  return results;
}

function walk(dir: string, out: ResourceFile[], cwd: string): void {
  let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out, cwd);
    } else if (entry.isFile() && [".yaml", ".yml"].includes(extname(entry.name))) {
      let parsed: Record<string, unknown> | undefined;
      try {
        parsed = yaml.load(readFileSync(full, "utf8")) as Record<string, unknown>;
      } catch {
        // skip unparseable files
      }
      if (parsed && typeof parsed.kind === "string") {
        // Missing/ambiguous file references throw rather than skip: skipping would
        // make a tracked resource look deleted.
        const inlined = inlineExternalFiles(parsed, full);
        out.push({ path: relative(cwd, full), resource: inlined as unknown as Resource });
      }
    }
  }
}
