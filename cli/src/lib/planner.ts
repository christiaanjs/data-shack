import { hashConfig } from "./hash.js";
import { resolveSecrets } from "./secrets.js";
import type { Resource, State, StateEntry } from "./types.js";

export type ChangeKind = "create" | "update" | "delete" | "no-change";

export interface Change {
  kind: ChangeKind;
  path: string;
  resource?: Resource;
  resolved?: Resource;
  existing?: StateEntry;
  hash?: string;
  error?: string;
}

const KIND_ORDER = ["credential", "storage-backend", "load-job", "transform", "saved-query"];

export function computePlan(
  files: Array<{ path: string; resource: Resource }>,
  state: State,
): Change[] {
  const changes: Change[] = [];
  const seen = new Set<string>();

  for (const { path, resource } of files) {
    seen.add(path);
    let resolved: Resource;
    let hash: string;
    try {
      resolved = resolveSecrets(resource);
      hash = hashConfig(resolved);
    } catch (e) {
      changes.push({ kind: "create", path, resource, error: (e as Error).message });
      continue;
    }
    const existing = state.resources[path];
    if (!existing) {
      changes.push({ kind: "create", path, resource, resolved, hash });
    } else if (existing.hash !== hash) {
      changes.push({ kind: "update", path, resource, resolved, hash, existing });
    } else {
      changes.push({ kind: "no-change", path, resource, resolved, hash, existing });
    }
  }

  for (const path of Object.keys(state.resources)) {
    if (!seen.has(path)) {
      changes.push({ kind: "delete", path, existing: state.resources[path] });
    }
  }

  return changes;
}

export function sortByKindOrder(changes: Change[]): Change[] {
  return [...changes].sort((a, b) => {
    const ak = a.resource?.kind ?? a.existing?.kind ?? "";
    const bk = b.resource?.kind ?? b.existing?.kind ?? "";
    return KIND_ORDER.indexOf(ak) - KIND_ORDER.indexOf(bk);
  });
}

export function sortByKindOrderReverse(changes: Change[]): Change[] {
  return [...changes].sort((a, b) => {
    const ak = a.resource?.kind ?? a.existing?.kind ?? "";
    const bk = b.resource?.kind ?? b.existing?.kind ?? "";
    return KIND_ORDER.indexOf(bk) - KIND_ORDER.indexOf(ak);
  });
}
