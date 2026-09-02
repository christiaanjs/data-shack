import type { ApiClient } from "./api.js";
import type {
  CredentialResource,
  LoadJobResource,
  Resource,
  SavedQueryResource,
  StateEntry,
  StorageBackendResource,
  TransformResource,
} from "./types.js";

export interface NameIndex {
  credByName: Map<string, string>;
  backendByName: Map<string, string>;
}

function backendFromUri(uri: string): string {
  const m = uri.match(/^r2(?:-s3compat)?:\/\/([^/]+)/);
  return m ? m[1]! : uri;
}

export async function fetchNameIndex(api: ApiClient): Promise<NameIndex> {
  const [credData, backendData] = await Promise.all([
    api.get<{ credentials: Array<{ id: string; name: string }> }>("/api/credentials"),
    api.get<{ backends: Array<{ id: string; name: string }> }>("/api/storage-backends"),
  ]);
  return {
    credByName: new Map(credData.credentials.map((c) => [c.name, c.id])),
    backendByName: new Map(backendData.backends.map((b) => [b.name, b.id])),
  };
}

export async function createResource(
  api: ApiClient,
  resource: Resource,
  idx: NameIndex,
): Promise<StateEntry> {
  switch (resource.kind) {
    case "credential":
      return createCredential(api, resource);
    case "storage-backend":
      return createBackend(api, resource);
    case "load-job":
      return createLoadJob(api, resource, idx);
    case "transform":
      return createTransform(api, resource);
    case "saved-query":
      return createSavedQuery(api, resource);
  }
}

export async function updateResource(
  api: ApiClient,
  resource: Resource,
  existing: StateEntry,
  idx: NameIndex,
): Promise<StateEntry> {
  switch (resource.kind) {
    case "credential":
      return updateCredential(api, resource, existing);
    case "storage-backend":
      return updateBackend(api, resource, existing);
    case "load-job":
      return updateLoadJob(api, resource, existing, idx);
    case "transform":
      return updateTransform(api, resource, existing);
    case "saved-query":
      // no PATCH endpoint — delete + recreate
      await api.delete(`/api/saved-queries/${existing.id}`);
      return createSavedQuery(api, resource);
  }
}

export async function deleteResource(api: ApiClient, existing: StateEntry): Promise<void> {
  switch (existing.kind) {
    case "credential":
      await api.delete(`/api/credentials/${existing.id}`);
      break;
    case "storage-backend":
      await api.delete(`/api/storage-backends/${existing.id}`);
      break;
    case "load-job":
      await api.delete(`/api/load-jobs/${existing.id}`);
      break;
    case "transform":
      if (existing.trigger_ids) {
        for (const tid of existing.trigger_ids) {
          await api.delete(`/api/triggers/${tid}`);
        }
      }
      await api.delete(`/api/transform-jobs/${existing.id}`);
      break;
    case "saved-query":
      await api.delete(`/api/saved-queries/${existing.id}`);
      break;
  }
}

// ── Credentials ────────────────────────────────────────────────────────────

async function createCredential(api: ApiClient, r: CredentialResource): Promise<StateEntry> {
  const data = await api.post<{ id: string }>("/api/credentials", {
    name: r.name,
    type: r.type,
    config: r.config,
  });
  return { id: data.id, kind: "credential", hash: "" };
}

async function updateCredential(
  api: ApiClient,
  r: CredentialResource,
  existing: StateEntry,
): Promise<StateEntry> {
  await api.patch(`/api/credentials/${existing.id}`, {
    name: r.name,
    config: r.config,
  });
  return { ...existing };
}

// ── Storage backends ───────────────────────────────────────────────────────

async function createBackend(api: ApiClient, r: StorageBackendResource): Promise<StateEntry> {
  const data = await api.post<{ id: string }>("/api/storage-backends", {
    name: r.name,
    type: r.type,
    config: r.config ?? {},
  });
  return { id: data.id, kind: "storage-backend", hash: "" };
}

async function updateBackend(
  api: ApiClient,
  r: StorageBackendResource,
  existing: StateEntry,
): Promise<StateEntry> {
  await api.patch(`/api/storage-backends/${existing.id}`, {
    name: r.name,
    config: r.config ?? {},
  });
  return { ...existing };
}

// ── Load jobs ──────────────────────────────────────────────────────────────

function resolveJobIds(
  r: LoadJobResource,
  idx: NameIndex,
): { credentialId: string; backendId: string } {
  const credentialId = idx.credByName.get(r.credential);
  if (!credentialId)
    throw new Error(
      `Credential '${r.credential}' not found. Create it first or ensure it exists in the API.`,
    );
  const backendId = idx.backendByName.get(r.storage_backend);
  if (!backendId)
    throw new Error(
      `Storage backend '${r.storage_backend}' not found. Create it first or ensure it exists in the API.`,
    );
  return { credentialId, backendId };
}

async function createLoadJob(
  api: ApiClient,
  r: LoadJobResource,
  idx: NameIndex,
): Promise<StateEntry> {
  const { credentialId, backendId } = resolveJobIds(r, idx);
  const data = await api.post<{ id: string }>("/api/load-jobs", {
    name: r.name,
    credential_id: credentialId,
    storage_backend_id: backendId,
    table_name: r.table_name,
    table_path: r.table_path,
    http_path: r.http_path,
    http_method: r.http_method,
    format: r.format,
    cron_schedule: r.cron_schedule,
    enabled: r.enabled !== false,
    source_type: r.source_type ?? "http",
    source_config: r.source_config,
    pagination_config: r.pagination_config,
    date_range_config: r.date_range_config,
  });
  return { id: data.id, kind: "load-job", hash: "" };
}

async function updateLoadJob(
  api: ApiClient,
  r: LoadJobResource,
  existing: StateEntry,
  idx: NameIndex,
): Promise<StateEntry> {
  const { credentialId, backendId } = resolveJobIds(r, idx);
  await api.patch(`/api/load-jobs/${existing.id}`, {
    name: r.name,
    credential_id: credentialId,
    storage_backend_id: backendId,
    table_name: r.table_name,
    table_path: r.table_path,
    http_path: r.http_path,
    http_method: r.http_method,
    format: r.format,
    cron_schedule: r.cron_schedule,
    enabled: r.enabled !== false,
    source_type: r.source_type ?? "http",
    source_config: r.source_config,
    pagination_config: r.pagination_config,
    date_range_config: r.date_range_config,
  });
  return { ...existing };
}

// ── Transforms ─────────────────────────────────────────────────────────────

async function createTransform(api: ApiClient, r: TransformResource): Promise<StateEntry> {
  const outputBackend = r.output_backend ?? backendFromUri(r.output_uri);
  const job = await api.post<{ id: string }>("/api/transform-jobs", {
    name: r.name,
    sql: r.sql,
    output_table: r.output_table,
    output_uri: r.output_uri,
    output_backend: outputBackend,
    format: r.format ?? "ndjson",
    requires_browser: r.requires_browser !== false,
  });

  const triggerIds = await createTriggers(api, job.id, r.triggers ?? []);
  return { id: job.id, kind: "transform", hash: "", trigger_ids: triggerIds };
}

async function updateTransform(
  api: ApiClient,
  r: TransformResource,
  existing: StateEntry,
): Promise<StateEntry> {
  const outputBackend = r.output_backend ?? backendFromUri(r.output_uri);
  await api.patch(`/api/transform-jobs/${existing.id}`, {
    name: r.name,
    sql: r.sql,
    output_table: r.output_table,
    output_uri: r.output_uri,
    output_backend: outputBackend,
    format: r.format ?? "ndjson",
    requires_browser: r.requires_browser !== false,
  });

  // Replace triggers: delete old, create new
  for (const tid of existing.trigger_ids ?? []) {
    await api.delete(`/api/triggers/${tid}`);
  }
  const triggerIds = await createTriggers(api, existing.id, r.triggers ?? []);
  return { ...existing, trigger_ids: triggerIds };
}

async function createTriggers(
  api: ApiClient,
  jobId: string,
  triggers: TransformResource["triggers"],
): Promise<string[]> {
  if (!triggers || triggers.length === 0) return [];
  const ids: string[] = [];
  for (const t of triggers) {
    const trig = await api.post<{ id: string }>("/api/triggers", {
      job_id: jobId,
      watches: t.watches,
      policy: t.policy ?? "any",
    });
    ids.push(trig.id);
  }
  return ids;
}

// ── Saved queries ──────────────────────────────────────────────────────────

async function createSavedQuery(api: ApiClient, r: SavedQueryResource): Promise<StateEntry> {
  const data = await api.post<{ query: { id: string } }>("/api/saved-queries", {
    name: r.name,
    sql: r.sql,
  });
  return { id: data.query.id, kind: "saved-query", hash: "" };
}
