import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { State } from "./types.js";

const STATE_PATH = ".dshack/state.json";

export function statePath(cwd = process.cwd()): string {
  return resolve(cwd, STATE_PATH);
}

export function loadState(cwd = process.cwd()): State {
  const path = statePath(cwd);
  if (!existsSync(path)) {
    throw new Error(`No state file at ${path}. Run 'dshack init <worker-url>' first.`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as State;
}

export function saveState(state: State, cwd = process.cwd()): void {
  const path = statePath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

export function createState(workerUrl: string, cwd = process.cwd()): State {
  const state: State = { version: 1, worker_url: workerUrl, resources: {} };
  saveState(state, cwd);
  return state;
}
