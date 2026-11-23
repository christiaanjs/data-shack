# data-shack

A personal data warehouse that runs on Cloudflare, with one unusual design choice: **the query engine runs in your browser.**

You point data-shack at the things you want to keep track of — a bank API, a Google Sheet, files in a bucket — and it pulls them on a schedule, stores them as files you own, and lets you query, transform and visualise them with plain SQL. Because SQL runs in a [DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview) instance in your own browser tab, there is no central compute server, and raw data never passes through one.

It is also built to be driven by AI. An [MCP](https://modelcontextprotocol.io) server lets an assistant such as Claude inspect your warehouse, run queries, and build dashboards and pipelines for you, and a CLI (`dshack`) lets you manage the whole setup as version-controlled YAML.

## Contents

- [How it works](#how-it-works)
- [Key concepts](#key-concepts)
- [Getting started](#getting-started)
- [Using data-shack](#using-data-shack)
  - [The web app](#the-web-app)
  - [Connecting data sources](#connecting-data-sources)
  - [Querying](#querying)
  - [Scheduled loads and transforms](#scheduled-loads-and-transforms)
  - [Dashboards](#dashboards)
  - [Using it from Claude (MCP)](#using-it-from-claude-mcp)
  - [Managing it as code (dshack CLI)](#managing-it-as-code-dshack-cli)
- [Repository layout](#repository-layout)
- [Development](#development)
- [Further reading](#further-reading)

## How it works

```
 External APIs ──► Load jobs ──► Object storage (R2 / S3) ◄──► Browser (DuckDB-WASM)
 Google Sheets    (server-side,   Parquet / NDJSON files          ▲   SQL, transforms,
                   on a cron)            │                        │   dashboards
                                         ▼                        │
                                   Catalog (table → snapshots) ───┘  live updates
                                                                      over WebSocket
```

1. **Load jobs** run on a cron schedule inside Cloudflare Workers. They fetch data from an HTTP API or a Google Sheet and write it to object storage as NDJSON.
2. Every file written is registered in the **catalog** as a new *snapshot* of a named table. The catalog is the single source of truth for what tables exist and which files back them.
3. The **browser** loads the catalog, creates a DuckDB view per table, and reads the files through an S3-compatible proxy on the Worker. You write SQL against ordinary table names.
4. **Transform jobs** are SQL queries that read tables and write a derived table back to storage. They fire automatically when their input tables get new data, and run in an open browser tab.
5. **Dashboards** are small React + Recharts components bound to SQL queries. They re-run whenever the underlying data changes.

Everything is Cloudflare-native — Workers, D1, R2, KV, Durable Objects, Queues and Pages — and everything is per-user: each user is their own tenant with their own catalog, credentials and storage.

## Key concepts

| Concept | What it is |
|---|---|
| **Storage backend** | Where data files live. Either the Worker's own R2 bucket (`r2-bound`) or any S3-compatible service (`r2-s3compat`). Config is encrypted in D1. |
| **Credential** | A stored secret used to reach a data source: an `http` API (headers with `{{variable}}` templates) or a `google-sheets` OAuth connection. Encrypted at rest; the browser never sees the raw values. |
| **Load job** | A cron-scheduled, server-side job that pulls from a credential's API or sheet, writes a file to a storage backend, and commits it to the catalog. Always runnable — needs no browser. |
| **Catalog** | Per-user metadata held in a Durable Object: tables, their snapshots (each a storage URI + format + timestamp), and a commit log. Browsers get a live broadcast on every commit. |
| **Transform job** | A SQL `COPY … TO` statement that derives a new table. Needs an open browser tab to run, and queues until one connects. |
| **Trigger** | Links watched tables to a transform job: fire on `any` new snapshot, or only when `all` watched tables have new data. This is how pipelines chain — there is no separate DAG scheduler. |
| **Dashboard** | A React + Recharts artifact plus the SQL queries that feed it, rendered in a sandboxed iframe. Reachable at `/dashboards/<slug>`. |
| **Saved query** | A named SQL snippet stored for reuse in the workbench. |

### URI schemes

Data is addressed by URI, so SQL, the catalog and jobs all speak the same language:

| Scheme | Meaning |
|---|---|
| `r2://backendName/path/file.parquet` | A file on any storage backend, looked up by backend name. (`r2-s3compat://backendId/…` is the legacy form and still works.) |
| `http-ds://credentialId/path` | A live call to an HTTP API through a stored credential; the Worker injects the auth headers. |
| `catalog://tableName` | The latest snapshot of a catalog table (used by the MCP `read_data` tool). |

## Getting started

You need a Cloudflare account, [`wrangler`](https://developers.cloudflare.com/workers/wrangler/), Node 22+, `openssl` and `jq`.

**1. Provision.** The bootstrap script creates the D1 database, applies migrations, walks you through creating a Google OAuth credential, generates a JWT secret and pushes all secrets to Cloudflare:

```bash
./scripts/bootstrap.sh                            # production (default)
./scripts/bootstrap.sh --env staging              # staging
./scripts/bootstrap.sh --env local                # local dev (writes .dev.vars)
./scripts/bootstrap.sh --env production --deploy  # bootstrap and deploy in one step
```

**2. Deploy.** The Worker deploys with `npm run deploy`. The frontend is a Cloudflare Pages project deployed from `frontend/` (`wrangler pages deploy`).

**3. Sign in.** Login is Google OAuth. New accounts are gated by an email allowlist (the `allowed_emails` table), so add your address before your first login; existing users are always admitted.

**4. Add a storage backend.** In **Settings → Storage Backends**, add an `r2-bound` backend (bucket `data-shack-storage`) or an `r2-s3compat` one. You can now point queries and jobs at it.

### Running locally

```bash
# Worker on http://localhost:8787 — needs a .dev.vars (bootstrap --env local writes one)
npm install
npm run migrate:local
npm run dev

# Frontend on http://localhost:5173
cd frontend && npm install && npm run dev
```

Set `ENABLE_DEV_AUTH=true`, `DEV_TOKEN` and `DEV_USER_ID` in `.dev.vars`, and `VITE_DEV_TOKEN` in `frontend/.env.local`, to skip the Google login. See `CLAUDE.md` for the full variable list.

## Using data-shack

### The web app

The main interface is the **workbench** at `/workbench`, a VS Code-style IDE: an explorer tree (catalog, transforms, saved queries, load jobs, dashboards, plus credentials and backends under Settings), tabbed editors, a console and history dock, and a `⌘K` command palette. A simpler tab-based UI is served at the other paths.

The browser DuckDB session can be switched off (it is off by default on phones). With it off you can still browse the catalog and open dashboards, which fall back to reading single tables straight from storage, but SQL, joins and transforms need the session on.

### Connecting data sources

**Files already in a bucket.** Seed a file and query it:

```bash
wrangler r2 object put data-shack-storage/sample.ndjson --file sample.ndjson
```

```sql
SELECT * FROM read_json('r2://primary-r2/sample.ndjson') LIMIT 100;

-- Hive-partitioned datasets work too; the Worker serves the listing DuckDB needs
SELECT * FROM read_parquet('r2://my-s3-backend/data/**/*.parquet', hive_partitioning=true);
```

**HTTP APIs.** Under **Settings → Credentials**, add a credential of type `http` with a base URL, headers and variables. Secrets go in `variables` and are referenced as `{{name}}`:

```json
{
  "baseUrl": "https://api.akahu.io/v1",
  "headers": { "Authorization": "Bearer {{userToken}}", "X-Akahu-Id": "{{appToken}}" },
  "variables": { "userToken": "user_token_...", "appToken": "app_..." }
}
```

Use the **Test** button to try a path, then query it live: `SELECT * FROM read_json('http-ds://cred_abc123/accounts')`.

**Google Sheets.** Add a credential of type `google-sheets`; a popup walks you through Google's consent screen and the refresh token is stored encrypted. Sheets can be loaded on a schedule, or used as a storage backend (reading returns JSON for `read_json`, writing updates the sheet; the object key names the tab).

### Querying

Everything registered in the catalog appears as a DuckDB view, so once data is loaded:

```sql
SELECT * FROM transactions LIMIT 100;
```

To register a file by hand, use the commit form on the **Catalog** tab (table name, URI, backend, format). Tables whose files cannot be resolved show a warning badge without blocking the others.

The full snapshot history is exposed as a plain table, `catalog_snapshots(table_name, snapshot_id, uri, url, backend, format, created_at)`, so SQL can read older versions or accumulate history across snapshots.

DuckDB can also write back to storage through the same proxy, including partitioned output:

```sql
COPY (SELECT date_trunc('month', created_at) AS month, amount FROM transactions)
TO 'r2://my-s3-backend/data/spending'
(FORMAT PARQUET, PARTITION_BY (month), OVERWRITE_OR_IGNORE true);
```

All storage traffic goes through the Worker, which holds the real credentials and re-signs requests, so the bucket needs no CORS policy and DuckDB only ever holds a short-lived proxy credential.

### Scheduled loads and transforms

**Load job.** In the workbench create a job with a table name, a credential, a storage backend, an HTTP path, a format (`ndjson`, `json`, `csv`, `parquet`) and a 5-field cron expression (e.g. `0 * * * *` for hourly). Each run writes a new timestamped file and commits it to the catalog; old files are kept. **Run now** triggers a job immediately. Paginated APIs are supported through `pagination_config` (cursor parameter, cursor path, data path), and Google Sheets can be a job source too.

**Transform job.** Write SQL that produces a derived table, give it an output table and URI, and add a trigger naming the tables it depends on. When a load job commits, the catalog fires every matching trigger and the job runs in your next open browser tab; its output is committed back to the catalog, which can fire further transforms downstream.

### Dashboards

A dashboard is a React component (default export, with [Recharts](https://recharts.org) available) that receives the results of its bound SQL queries as `data[0]`, `data[1]`, …. Source is limited to 50 KB. Dashboards render in a `sandbox="allow-scripts"` iframe with no access to the app's cookies or storage, and re-run their queries on every catalog commit.

Each has a shareable URL (`/dashboards/<slug>`). On Android and iOS the app is an installable PWA, and a dashboard can be added to the home screen as its own shortcut.

You can build dashboards in the workbench's editor, or conversationally with Claude (below).

### Using it from Claude (MCP)

data-shack exposes an MCP server at `/mcp` (Streamable HTTP, behind the same OAuth login), so any MCP-capable assistant can use your warehouse. Claude is the reference example: add `https://<your-worker>/mcp` as a custom connector in Claude, sign in with Google, and Claude can then:

- **Explore** — `get_warehouse_schema` (tables, snapshots, which are directly readable), `list_data_sources`
- **Query** — `run_query` (executes in your open browser tab) and `read_data` (reads an `r2://`, `http-ds://` or `catalog://` URI, up to 1 MB, no browser needed)
- **Build dashboards** — `submit_dashboard`, `list_dashboards`, `get_dashboard`, `update_dashboard`; previous versions are snapshotted automatically
- **Build pipelines** — create, edit, enable/disable, trigger and delete load jobs, transform jobs and triggers

A typical session: ask Claude what's in the warehouse, have it explore a table with `run_query`, iterate on a chart, then ask it to save the result as a dashboard you can open on your phone. Only `run_query` and running transform jobs need a browser tab open; everything else works on the server alone. Claude can also reference credentials and backends by name, so you never paste secrets into a chat.

### Managing it as code (dshack CLI)

`dshack` (in [`cli/`](cli/README.md)) manages your warehouse resources — credentials, storage backends, load jobs, transforms with triggers, saved queries and dashboards — as YAML files in a git repository, in the style of Terraform:

```bash
cd cli && npm ci && npm run build && npm link

dshack auth login https://your-worker.workers.dev
dshack init https://your-worker.workers.dev --pull   # import what already exists as YAML
dshack plan                                          # diff files against the live API
dshack apply                                         # create / update / delete
```

SQL and JSX live in their own files next to the YAML, secrets are `$ENV:NAME` references that never touch disk, and a committed `.dshack/state.json` maps files to live resources. For CI, mint a long-lived token with `dshack auth create-token <name>` and set `DS_TOKEN` and `DS_WORKER_URL`. See the [CLI README](cli/README.md) for the resource schemas.

## Repository layout

| Path | Contents |
|---|---|
| `src/` | The Cloudflare Worker (Hono): auth, REST API, MCP server, storage proxy, loaders, catalog and session Durable Objects |
| `migrations/` | D1 schema migrations |
| `test/` | Worker tests, run in the real Workers runtime via Miniflare |
| `frontend/` | The Pages SPA (Preact + Vite): workbench IDE, DuckDB-WASM, dashboard viewer, plus Pages Functions for per-dashboard PWA manifests |
| `cli/` | The `dshack` infrastructure-as-code CLI |
| `scripts/` | `bootstrap.sh` environment provisioning |

The worker and frontend are independent packages with separate `node_modules`.

## Development

Before every commit, run all three checks (CI enforces them):

```bash
npm test          # Worker tests
npm run typecheck
npm run lint      # Biome: lint, format and import order, covers frontend/ too
cd frontend && npm run typecheck
```

Open issues are tracked with [Beads](https://github.com/gastownhall/beads) (`bd ready`, `bd list`). `CLAUDE.md` holds detailed implementation notes for contributors and coding agents.

## Further reading

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — system diagram, components, data flows and design principles
- [`cli/README.md`](cli/README.md) — `dshack` commands and resource schemas
- [`CLAUDE.md`](CLAUDE.md) — implementation-level notes
