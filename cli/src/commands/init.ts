import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import pc from "picocolors";
import { ApiClient } from "../lib/api.js";
import { loadAuth } from "../lib/auth.js";
import { normalizeText, writeSidecar } from "../lib/external-files.js";
import { hashConfig } from "../lib/hash.js";
import { sanitizeConfig } from "../lib/sanitize.js";
import { createState, saveState } from "../lib/state.js";
import type { State } from "../lib/types.js";

// Env vars (name → real value) for secrets replaced by $ENV refs during a pull.
const pulledEnv: Record<string, string> = {};

const DIRS = ["data-sources", "transforms", "catalog", "dashboards"];

interface LoadJob {
  id: string;
  name: string;
  credential_id: string;
  storage_backend_id: string;
  table_name: string;
  table_path: string;
  http_path: string;
  http_method: string;
  format: string;
  cron_schedule: string;
  enabled: number;
  source_type: string;
  source_config: string | null;
  pagination_config: string | null;
  date_range_config: string | null;
}

interface TransformJob {
  id: string;
  name: string | null;
  sql: string;
  output_table: string;
  output_uri: string;
  output_backend: string;
  format: string | null;
  requires_browser: number;
}

interface Trigger {
  id: string;
  watches: string[];
  policy: string;
  job_id: string;
}

interface SavedQuery {
  id: string;
  name: string;
  sql: string;
}

interface DashboardRow {
  id: string;
  title: string;
  slug: string | null;
}

interface DashboardDetail extends DashboardRow {
  artifact_source: string;
  queries: string[];
}

interface CredentialRow {
  id: string;
  name: string;
  type: string;
}

interface BackendRow {
  id: string;
  name: string;
  type: string;
}

export async function initCommand(workerUrl: string, opts: { pull?: boolean }): Promise<void> {
  const cwd = process.cwd();
  const stateDir = resolve(cwd, ".dshack");

  if (existsSync(resolve(cwd, ".dshack/state.json"))) {
    console.log(
      pc.yellow("Already initialized (.dshack/state.json exists). Use --pull to refresh."),
    );
    if (!opts.pull) return;
  }

  // Scaffold directories
  for (const dir of DIRS) {
    mkdirSync(resolve(cwd, dir), { recursive: true });
    const keep = resolve(cwd, dir, ".gitkeep");
    if (!existsSync(keep)) writeFileSync(keep, "");
  }
  mkdirSync(stateDir, { recursive: true });

  if (!opts.pull) {
    createState(workerUrl, cwd);
    console.log(pc.green("✓ Initialized .dshack/state.json"));
    console.log(pc.dim(`  Directories created: ${DIRS.join(", ")}`));
    console.log(pc.dim(`  Run 'dshack plan' to see pending changes.`));
    return;
  }

  const auth = loadAuth();
  if (!auth) {
    console.error(pc.red("Not authenticated. Run: dshack auth login <worker-url>"));
    process.exit(1);
  }
  const api = new ApiClient({ ...auth, worker_url: workerUrl });

  console.log("Pulling existing resources...");
  const state = createState(workerUrl, cwd);

  await pullCredentials(api, state, cwd);
  await pullBackends(api, state, cwd);
  await pullLoadJobs(api, state, cwd);
  await pullTransforms(api, state, cwd);
  await pullSavedQueries(api, state, cwd);
  await pullDashboards(api, state, cwd);

  saveState(state, cwd);
  console.log(pc.green(`\n✓ Pulled ${Object.keys(state.resources).length} resources into state.`));
  const names = Object.keys(pulledEnv).sort();
  if (names.length > 0) {
    console.log(
      pc.yellow(
        "\nSecrets were NOT written to disk. Set these env vars before `dshack plan` / `apply`:",
      ),
    );
    for (const n of names) console.log(`  ${n}`);
  }
}

async function pullCredentials(api: ApiClient, state: State, cwd: string): Promise<void> {
  const { credentials } = await api.get<{ credentials: CredentialRow[] }>("/api/credentials");
  for (const cred of credentials) {
    const detail = await api.get<{
      id: string;
      name: string;
      type: string;
      config: Record<string, unknown>;
    }>(`/api/credentials/${cred.id}`);
    const resource = {
      kind: "credential",
      name: cred.name,
      type: cred.type,
      config: detail.config,
    };
    const { config, env } = sanitizeConfig(cred.name, detail.config, {
      maskAllVariables: cred.type === "http",
    });
    Object.assign(pulledEnv, env);
    const path = `data-sources/credentials/${slugify(cred.name)}.yaml`;
    writeYaml(resolve(cwd, path), { ...resource, config });
    state.resources[path] = {
      id: cred.id,
      kind: "credential",
      hash: hashConfig({ ...resource, config }),
    };
    console.log(pc.dim(`  + ${path}`));
  }
}

async function pullBackends(api: ApiClient, state: State, cwd: string): Promise<void> {
  const { backends } = await api.get<{ backends: BackendRow[] }>("/api/storage-backends");
  for (const b of backends) {
    const detail = await api.get<{
      id: string;
      name: string;
      type: string;
      config: Record<string, unknown>;
    }>(`/api/storage-backends/${b.id}`);
    const resource = { kind: "storage-backend", name: b.name, type: b.type, config: detail.config };
    const { config, env } = sanitizeConfig(b.name, detail.config ?? {});
    Object.assign(pulledEnv, env);
    const path = `data-sources/backends/${slugify(b.name)}.yaml`;
    writeYaml(resolve(cwd, path), { ...resource, config });
    state.resources[path] = {
      id: b.id,
      kind: "storage-backend",
      hash: hashConfig({ ...resource, config }),
    };
    console.log(pc.dim(`  + ${path}`));
  }
}

async function pullLoadJobs(api: ApiClient, state: State, cwd: string): Promise<void> {
  const { jobs } = await api.get<{ jobs: LoadJob[] }>("/api/load-jobs");
  const { credentials } = await api.get<{ credentials: CredentialRow[] }>("/api/credentials");
  const { backends } = await api.get<{ backends: BackendRow[] }>("/api/storage-backends");
  const credById = new Map(credentials.map((c) => [c.id, c.name]));
  const backendById = new Map(backends.map((b) => [b.id, b.name]));

  for (const job of jobs) {
    const resource: Record<string, unknown> = {
      kind: "load-job",
      name: job.name,
      credential: credById.get(job.credential_id) ?? job.credential_id,
      storage_backend: backendById.get(job.storage_backend_id) ?? job.storage_backend_id,
      table_name: job.table_name,
      table_path: job.table_path,
      http_path: job.http_path,
      http_method: job.http_method,
      format: job.format,
      cron_schedule: job.cron_schedule,
      enabled: job.enabled === 1,
    };
    if (job.source_type && job.source_type !== "http") resource.source_type = job.source_type;
    if (job.source_config) resource.source_config = JSON.parse(job.source_config);
    if (job.pagination_config) resource.pagination_config = JSON.parse(job.pagination_config);
    if (job.date_range_config) resource.date_range_config = JSON.parse(job.date_range_config);

    const path = `data-sources/jobs/${slugify(job.name)}.yaml`;
    writeYaml(resolve(cwd, path), resource);
    state.resources[path] = { id: job.id, kind: "load-job", hash: hashConfig(resource) };
    console.log(pc.dim(`  + ${path}`));
  }
}

async function pullTransforms(api: ApiClient, state: State, cwd: string): Promise<void> {
  const { jobs } = await api.get<{ jobs: TransformJob[] }>("/api/transform-jobs");
  const { triggers } = await api.get<{ triggers: Trigger[] }>("/api/triggers");
  const trigsByJob = new Map<string, Trigger[]>();
  for (const t of triggers) {
    const list = trigsByJob.get(t.job_id) ?? [];
    list.push(t);
    trigsByJob.set(t.job_id, list);
  }

  for (const job of jobs) {
    const jobTriggers = trigsByJob.get(job.id) ?? [];
    const resource: Record<string, unknown> = {
      kind: "transform",
      name: job.name ?? job.id,
      output_table: job.output_table,
      output_uri: job.output_uri,
      format: job.format ?? "ndjson",
      requires_browser: job.requires_browser === 1,
      sql: normalizeText(job.sql),
    };
    if (job.output_backend) resource.output_backend = job.output_backend;
    if (jobTriggers.length > 0) {
      resource.triggers = jobTriggers.map((t) => ({
        watches: t.watches,
        policy: t.policy,
      }));
    }

    const path = `transforms/${slugify(job.name ?? job.id)}.yaml`;
    // The SQL lives in a sibling .sql file so editors highlight it.
    const { sql, ...rest } = resource;
    const sqlFile = `${slugify(job.name ?? job.id)}.sql`;
    writeSidecar(resolve(cwd, path), sqlFile, sql as string);
    writeYaml(resolve(cwd, path), { ...rest, sql_file: sqlFile });
    state.resources[path] = {
      id: job.id,
      kind: "transform",
      hash: hashConfig(resource),
      trigger_ids: jobTriggers.map((t) => t.id),
    };
    console.log(pc.dim(`  + ${path}`));
  }
}

async function pullSavedQueries(api: ApiClient, state: State, cwd: string): Promise<void> {
  const { queries } = await api.get<{ queries: SavedQuery[] }>("/api/saved-queries");
  for (const q of queries) {
    const resource = { kind: "saved-query", name: q.name, sql: normalizeText(q.sql) };
    const path = `catalog/${slugify(q.name)}.yaml`;
    const sqlFile = `${slugify(q.name)}.sql`;
    writeSidecar(resolve(cwd, path), sqlFile, resource.sql);
    writeYaml(resolve(cwd, path), { kind: resource.kind, name: resource.name, sql_file: sqlFile });
    state.resources[path] = { id: q.id, kind: "saved-query", hash: hashConfig(resource) };
    console.log(pc.dim(`  + ${path}`));
  }
}

async function pullDashboards(api: ApiClient, state: State, cwd: string): Promise<void> {
  const { dashboards } = await api.get<{ dashboards: DashboardRow[] }>("/api/dashboards");
  for (const d of dashboards) {
    const detail = await api.get<DashboardDetail>(`/api/dashboards/${d.id}`);
    const dir = `dashboards/${slugify(detail.slug ?? detail.title) || detail.id}`;
    const path = `${dir}/dashboard.yaml`;
    const queries = detail.queries.map(normalizeText);
    const resource = {
      kind: "dashboard",
      title: detail.title,
      slug: detail.slug,
      artifact_source: normalizeText(detail.artifact_source),
      queries,
    };
    const abs = resolve(cwd, path);
    // Dashboard code is JSX (React + Recharts), queries are SQL — both get their own files.
    writeSidecar(abs, "artifact.jsx", resource.artifact_source);
    const queryFiles = queries.map((q, i) => {
      const f = `query-${i + 1}.sql`;
      writeSidecar(abs, f, q);
      return f;
    });
    writeYaml(abs, {
      kind: "dashboard",
      title: detail.title,
      slug: detail.slug,
      artifact_file: "artifact.jsx",
      query_files: queryFiles,
    });
    state.resources[path] = { id: detail.id, kind: "dashboard", hash: hashConfig(resource) };
    console.log(pc.dim(`  + ${path}`));
  }
}

function writeYaml(absPath: string, obj: unknown): void {
  mkdirSync(resolve(absPath, ".."), { recursive: true });
  writeFileSync(absPath, yaml.dump(obj, { lineWidth: -1 }));
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
