import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { AuthConfig } from "./types.js";

function authFilePath(): string {
  return resolve(homedir(), ".config", "dshack", "auth.json");
}

export function loadAuth(workerUrl?: string): AuthConfig | null {
  if (process.env.DS_TOKEN) {
    const url = workerUrl ?? process.env.DS_WORKER_URL ?? "";
    if (!url) return null;
    return { access_token: process.env.DS_TOKEN, worker_url: url };
  }
  const path = authFilePath();
  if (!existsSync(path)) return null;
  const cfg = JSON.parse(readFileSync(path, "utf8")) as AuthConfig;
  if (workerUrl && cfg.worker_url !== workerUrl) return null;
  return cfg;
}

export function saveAuth(config: AuthConfig): void {
  const path = authFilePath();
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function clearAuth(): void {
  const path = authFilePath();
  if (existsSync(path)) writeFileSync(path, "");
}

export function requireAuth(workerUrl?: string): AuthConfig {
  const auth = loadAuth(workerUrl);
  if (!auth) {
    console.error("Not authenticated. Run: dshack auth login <worker-url>");
    process.exit(1);
  }
  if (!auth.worker_url) {
    console.error("No worker URL in auth config. Run: dshack auth login <worker-url>");
    process.exit(1);
  }
  return auth;
}
