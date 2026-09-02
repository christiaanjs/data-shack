import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import yaml from "js-yaml";
import type { Resource } from "./types.js";

const RESOURCE_DIRS = ["data-sources", "transforms", "catalog"];

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
      try {
        const parsed = yaml.load(readFileSync(full, "utf8")) as Record<string, unknown>;
        if (parsed && typeof parsed.kind === "string") {
          out.push({ path: relative(cwd, full), resource: parsed as unknown as Resource });
        }
      } catch {
        // skip unparseable files
      }
    }
  }
}
