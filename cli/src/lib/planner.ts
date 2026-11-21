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

const KIND_ORDER = [
  "credential",
  "storage-backend",
  "load-job",
  "transform",
  "saved-query",
  "dashboard",
];

export function computePlan(
  files: Array<{ path: string; resource: Resource }>,
  state: State,
): Change[] {
  const changes: Change[] = [];
  const seen = new Set<string>();

  for (const { path, resource } of files) {
    seen.add(path);
    // Hash the file as written ($ENV refs unresolved) so unchanged resources
    // can be planned without any secret env vars. Rotating a secret's value
    // without editing the YAML is therefore not detected as a change.
    const hash = hashConfig(resource);
    const existing = state.resources[path];
    if (existing && existing.hash === hash) {
      changes.push({ kind: "no-change", path, resource, hash, existing });
      continue;
    }
    // Secrets are only needed for resources that will actually be written.
    let resolved: Resource | undefined;
    let error: string | undefined;
    try {
      resolved = resolveSecrets(resource);
    } catch (e) {
      error = (e as Error).message;
    }
    changes.push({
      kind: existing ? "update" : "create",
      path,
      resource,
      resolved,
      hash,
      existing,
      error,
    });
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
