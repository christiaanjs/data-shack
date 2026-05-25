# Personal Data Warehouse

A personal data integration platform built on Cloudflare that brings your data together for querying, analysis, and dashboarding — with a privacy-preserving twist: the compute engine runs in your own browser.

## What's built

| Component | Status |
|---|---|
| OAuth 2.0 worker (Google, PKCE, DCR, JWT, refresh rotation) | ✅ Done |
| Email allowlist: `allowed_emails` table gates new signups; existing users unaffected | ✅ Done |
| D1 schema: users, oauth tables, credentials, storage_backends, allowed_emails | ✅ Done |
| Credential + storage backend vault (AES-GCM encrypted in D1) | ✅ Done |
| S3-compatible storage proxy: KV-backed proxy credentials, GET/HEAD/PUT/LIST/OPTIONS with CORS and ETags | ✅ Done |
| Partitioned writes and hive-partitioned reads: DuckDB `COPY TO … PARTITION_BY` and `read_parquet('…/**/*.parquet', hive_partitioning=true)` | ✅ Done |
| `r2://name/key` URI scheme — universal for both backend types, resolved by name first, ID fallback | ✅ Done |
| DuckDB-WASM query engine in the browser | ✅ Done |
| Query UI: URI resolver + SQL editor + results table | ✅ Done |
| Settings UI: manage credentials and storage backends; inline edit for backends | ✅ Done |
| `http` credential type: configurable headers with `{{variable}}` templates | ✅ Done |
| HTTP data source proxy: `http-ds://` URI scheme + token endpoint for DuckDB | ✅ Done |
| Settings test dialog: call any HTTP data source path and see the raw response | ✅ Done |
| Catalog Durable Object: tables, snapshots, commits; per-user DO isolation | ✅ Done |
| Catalog UI: commit snapshots, edit URI/format, URI convention docs | ✅ Done |
| Browser auto-registers DuckDB views from catalog on startup | ✅ Done |
| Load jobs: cron-triggered HTTP→R2/S3 ETL with catalog commit, Queue-based execution | ✅ Done |
| Load Jobs UI: create/edit/delete jobs, "Run now" trigger, last-run status | ✅ Done |
| Session Durable Object: WebSocket hibernation, MCP query relay, transform job dispatch on connect | ✅ Done |
| MCP server: Streamable HTTP (2025-03-26), `get_warehouse_schema` / `list_data_sources` / `run_query` / `read_data` tools | ✅ Done |
| Transform jobs + triggers: catalog DO queue, session DO dispatch, browser DuckDB execution | ✅ Done |
| Dashboarding platform | Not started |

See [`build-plan.md`](./build-plan.md) for the full sequenced plan.

## Current capability

### Querying object storage (R2 and S3-compatible)

A signed-in user can query files in R2 or any S3-compatible backend from DuckDB running in the browser. The frontend requests short-lived proxy credentials from the worker (`POST /api/storage/proxy-credentials`), configures DuckDB's httpfs with a `CREATE SECRET`, and all storage traffic flows through `/api/storage/s3proxy` on the worker.

Seed a file to try it:
```
wrangler r2 object put data-shack-storage/sample.ndjson --file sample.ndjson
```

Then query it from the **Query** tab:
```sql
-- Single file (r2-bound backend — use the backend name from Settings)
SELECT * FROM read_json('r2://primary-r2/sample.ndjson') LIMIT 100

-- Hive-partitioned dataset — use backend name (r2-bound or r2-s3compat)
-- Worker serves the ListObjectsV2 DuckDB needs to discover partitions
SELECT * FROM read_parquet('r2://my-s3-backend/data/**/*.parquet', hive_partitioning=true)
```

The `r2://backendName/key` scheme works for both `r2-bound` and `r2-s3compat` backends. The Worker resolves the name to the appropriate backend at request time. The legacy `r2-s3compat://backendId/key` scheme still works for backwards compatibility.

The `r2://backendName/key` URI scheme is translated to `s3://backendName/key` internally — DuckDB never sees raw storage credentials. The Worker resolves the backend name (or ID for the legacy `r2-s3compat://` scheme) at credential-vend time.

### Writing query results to storage

DuckDB writes natively to the S3 proxy using the same proxy credential as reads. Partitioned writes work because DuckDB drives every `PUT` through the credential — no special setup required:

```sql
-- Single file (r2-bound backend named "primary-r2")
COPY (SELECT * FROM read_json('r2://primary-r2/raw.ndjson'))
TO 'r2://primary-r2/output.parquet' (FORMAT PARQUET)

-- Partitioned by column — DuckDB generates one file per partition automatically
-- Works with any backend type; use the backend name from Settings
COPY (SELECT date_trunc('month', created_at) AS month, amount FROM transactions)
TO 'r2://my-s3-backend/data/spending' (FORMAT PARQUET, PARTITION_BY (month), OVERWRITE_OR_IGNORE true)
```

No CORS policy is needed on the upstream bucket. All storage traffic goes through the worker proxy endpoint, which re-signs requests to the real backend before forwarding.

### Catalog: tracking and querying tables

The **Catalog** tab lets you register files in object storage as named tables that DuckDB automatically sees on startup.

1. Go to the **Catalog** tab and fill in the commit form:
   - **Table name** — e.g. `transactions`
   - **URI** — e.g. `r2://primary-r2/transactions/2026-05.parquet`
   - **Storage backend** — the backend name from Settings (e.g. `primary-r2`)
   - **Format** — leave as Auto to infer from the file extension, or pick explicitly if the extension is misleading (e.g. a `.json` file that is actually NDJSON)

2. URI convention — use `r2://backendName/path` for all backend types:
   - `r2://primary-r2/folder/file.parquet` — backend name `primary-r2` is resolved by the Worker; for `r2-bound`, everything after the first `/` is scoped to your user namespace in the bucket.
   - `r2://my-s3-backend/folder/file.parquet` — same scheme for `r2-s3compat` backends; the path is relative to the bucket root.
   - The legacy `r2-s3compat://backendId/path` scheme still works if you have existing URIs with backend IDs.

3. Go to **Settings → Storage Backends** to rename or edit a backend's config. The **Edit** button opens a dialog pre-filled with the decrypted config.

3. Open the **Query** tab. The catalog is loaded automatically — registered tables appear as badges and are available as DuckDB views:
   ```sql
   SELECT * FROM transactions LIMIT 100
   ```
   Both `r2://` and `http-ds://` snapshot URIs are supported. `r2://` tables create views via S3 proxy credentials; `http-ds://` tables are resolved to token URLs and create `read_json` views. Tables with unresolvable URIs (missing files, wrong backend, expired token) show a ⚠ badge but don't block other tables from loading.

4. To correct a committed snapshot, click **Edit** on its row in the Catalog tab to update the URI or format in-place.

### Querying HTTP APIs (Akahu, etc.)

External HTTP APIs can be queried directly from DuckDB using the `http` credential type and the `http-ds://` URI scheme:

1. Go to **Settings → Credentials** and add a credential with type `http`. The form pre-fills a template — fill in your `baseUrl`, headers (using `{{variableName}}` for secrets), and `variables`. For Akahu:
   ```json
   {
     "baseUrl": "https://api.akahu.io/v1",
     "headers": {
       "Authorization": "Bearer {{userToken}}",
       "X-Akahu-Id": "{{appToken}}"
     },
     "variables": {
       "userToken": "user_token_...",
       "appToken": "app_..."
     }
   }
   ```
2. Use the **Test** button on the credential row to verify it works against a specific path.
3. In the **Query** tab, use the credential ID in an `http-ds://` URI:
   ```sql
   SELECT * FROM read_json('http-ds://cred_abc123/accounts') LIMIT 10
   ```
   The worker resolves the URI to a short-lived signed proxy URL. DuckDB fetches through the Worker, which injects the configured auth headers before forwarding to the API.

### Scheduled data ingestion (load jobs)

The **Load Jobs** tab lets you define cron-triggered jobs that pull from an HTTP API and write the response to a storage backend, committing a new snapshot URI to the catalog.

1. Go to **Settings → Storage Backends** and add an `r2-bound` backend (bucket = `data-shack-storage`) if you want to write to the primary R2 bucket.
2. Go to **Settings → Credentials** and add an `http` credential for your API.
3. Open the **Load Jobs** tab and click **New job**:
   - **Table name** — SQL identifier for the catalog table (e.g. `accounts`)
   - **Storage path** — optional custom directory within the backend (defaults to table name). For `r2-bound`, this is relative to your user namespace; for `r2-s3compat`, relative to the bucket root.
   - **HTTP credential** — the credential to use for the upstream API call
   - **Storage backend** — where to write the output file
   - **HTTP Path** — path appended to the credential's base URL (e.g. `/v1/accounts`)
   - **Format** — `ndjson`, `json`, `csv`, or `parquet`
   - **Cron schedule** — standard 5-field cron expression (e.g. `0 * * * *` = hourly)
4. Click **Run now** to trigger an immediate run without waiting for the cron. The job fetches the API response, streams it to storage (using `FixedLengthStream` when `Content-Length` is available, buffering otherwise), and commits the file URI to the catalog.
5. Each run creates a new timestamped file (`{tableDir}/load-{timestamp}.{ext}`). Old files are retained; the catalog always points to the latest snapshot.

The **Settings** tab stores storage backend configs (encrypted in D1). Backends can be created, renamed (via the **Edit** button), and deleted. Both `r2-bound` and `r2-s3compat` backends are fully dispatched — `r2-bound` uses the Worker's R2 binding directly; `r2-s3compat` re-signs upstream SigV4 requests using config from D1. Full dispatch for `s3`, `gcs`, and `azure` backend types is deferred to a later stage.

## Architecture Overview

The system is built on Cloudflare's stack (Workers, D1, R2, Durable Objects, Pages) with OAuth 2.0 (Google) and JWT-based authentication. SQL execution happens in a **browser-local DuckDB-WASM instance** rather than on the server. The server orchestrates; your browser computes.

The Worker proxy acts as an S3-compatible endpoint: the browser requests short-lived proxy credentials from `POST /api/storage/proxy-credentials`, configures DuckDB's httpfs with a `CREATE OR REPLACE SECRET`, and all subsequent storage operations (GET, HEAD, PUT, ListObjectsV2) flow through `/api/storage/s3proxy` on the Worker. Storage backends are pluggable — the Worker translates the S3 protocol to R2 binding calls (for `r2-bound`) or re-signed upstream S3 requests (for `r2-s3compat`), and DuckDB is unaware of which backend it's talking to.

## Core Components

### Browser Compute Engine

A Cloudflare Pages frontend hosts a DuckDB-WASM instance. The browser is the query engine — all SQL execution, including joins across sources, runs locally. Raw data never passes through a central compute server.

The browser communicates with the Cloudflare stack in two ways:

- **Catalog WebSocket** — a long-lived connection to the catalog Durable Object. The browser receives a broadcast whenever new data commits, and re-runs any affected queries automatically.
- **Session WebSocket** — a connection to the session Durable Object, which enables the MCP server to route queries into the browser and stream results back.

For data access, the browser requests a resolved HTTPS URL from the Worker proxy storage resolver and reads Parquet and NDJSON files directly from the storage backend via `httpfs`. For transform job outputs, the browser requests a writable URL and writes Parquet directly to the storage backend. The browser never knows which backend it is talking to — it always receives a plain HTTPS URL.

### Worker Proxy

Cloudflare Workers sit between all clients (browser, ETL Workers, MCP server) and the backend. The Worker proxy is responsible for:

- Validating Bearer JWTs on every request
- Decrypting source credentials and storage backend config from D1 at request time
- Resolving storage URIs to readable or writable HTTPS URLs — signed URLs for R2/S3/GCS, SAS tokens for Azure, passthrough for public HTTPS endpoints — with URI prefix validation before any writable URL is issued
- Forwarding catalog and job queue operations to the catalog Durable Object

For the primary R2 backend, ETL Workers use the native R2 Worker binding directly. For other backend types they use `fetch()` with credentials from D1. The catalog and browser are unaware of which mechanism was used.

### Catalog Durable Object

The catalog DO is the source of truth for all warehouse metadata. It holds a SQLite database with:

- `tables` — table definitions (name, description, created_at)
- `snapshots` — every storage URI that constitutes a table, with backend ID, access mode, format, and timestamp
- `commits` — a log of every change, enabling time-travel queries
- `jobs` — the pending/claimed/done queue for transform jobs *(deferred to Stage 7)*
- `triggers` — the mapping from input tables to downstream transform jobs *(deferred to Stage 7)*

Each user gets their own DO instance, isolated by user ID. All writes are processed single-threadedly inside the DO isolate, eliminating race conditions between concurrent ETL Workers. After every commit, the DO will broadcast a notification to all connected browser tabs over WebSocket *(deferred to Stage 5)*.

This is a distinct class from the session DO. The catalog DO holds persistent state that outlives any browser session. The session DO is ephemeral — it exists only to route MCP queries to an active browser tab.

### Session Durable Object

The session DO pairs an MCP query request with an active browser tab. When the browser connects, it registers a WebSocket with the session DO. When the MCP server receives a query, it forwards it through the session DO to the browser, and streams the result back. If no browser tab is open, the MCP server reports that no session is available rather than hanging.

On browser connect, the session DO also checks the job queue for pending transform jobs and dispatches them to the browser.

### Data Sources and ETL

Data enters the warehouse via two job types with a clear semantic split:

**Load jobs** run entirely server-side in Cloudflare Workers on a cron schedule. They have no browser dependency and are always runnable. A load job pulls from an external API, writes raw data to a configured storage backend (as NDJSON for simplicity, or Parquet for large batches), and commits the new snapshot URI to the catalog DO. The load job definition records which `storage_backend` ID to write to; the Worker looks up the backend config from D1. On completion, the catalog DO evaluates the `triggers` table and enqueues any downstream transform jobs.

**Transform jobs** require a browser DuckDB session. They read from storage (resolving snapshot URIs to HTTPS URLs via the Worker proxy), register each input as a named DuckDB view, run a SQL query, write the result as Parquet to a storage backend via a Worker-resolved writable URL, and commit the new snapshot URI to the catalog DO. If the browser session closes mid-job, the session DO resets the job to `pending` and the next browser session re-claims it. Transform jobs are idempotent by construction — the output URI and input URIs are deterministic, so re-running produces the same result.

The primary transform job type is **compaction**: accumulating NDJSON staging files are merged into a single sorted, ZSTD-compressed Parquet file with row group statistics that enable DuckDB to skip irrelevant row groups on filtered queries.

**Trigger-on-commit** is the scheduling mechanism. There is no separate DAG scheduler. After every catalog commit, the DO checks whether all watched input tables for any pending transform trigger have commits newer than the trigger's last run. If so, it enqueues the transform job. This handles both single-input triggers (compact `transactions` after every Akahu load) and multi-input triggers (derive `monthly_spending` only after both `transactions` and `budget` have fresh commits).

Supported data sources:
- **Akahu** — NZ banking API (load job, cron-triggered)
- **Google Sheets** — via OAuth (load job, cron-triggered; OAuth flow handled in the browser)
- **R2** — Parquet and NDJSON files directly
- **D1** — structured tables

### MCP Server

An MCP server exposes the warehouse to AI clients like Claude. Because the catalog DO holds all schema and snapshot metadata, many operations do not require an active browser session:

Currently implemented:
- `get_warehouse_schema` — table list, schemas, snapshot metadata (no browser session required)
- `list_data_sources` — lists HTTP credentials with their names and base URLs (no browser session required)
- `run_query` — execute SQL in the browser DuckDB session; requires an active browser tab
- `read_data` — read JSON/NDJSON directly from an `http-ds://` or `r2://` URI (no browser session required, 1 MB limit)

Planned (not yet implemented):
- `list_etl_jobs` — active job definitions and schedules
- `create_load_job` — define a new source connector and cron schedule
- `create_transform_job` — define a derived table with its SQL and input dependencies
- `pause_etl_job` — disable a job without deleting it
- `submit_dashboard` — persist a Claude-authored dashboard artifact

### Dashboarding Platform

Dashboards are React artifacts with props bound to SQL queries. The authoring workflow:

1. The user iterates on visualisations and calculations with Claude inside Claude.ai, with live warehouse data via the MCP server and browser session.
2. Once satisfied, Claude calls `submit_dashboard` via MCP.
3. The Worker proxy validates the artifact for XSS risks before persisting it to D1.
4. The dashboard viewer in the Pages frontend loads persisted dashboards, subscribes to the catalog DO WebSocket for the tables their queries touch, and re-runs bound queries automatically on commit.

## Storage Access Pattern

Storage backends are configured in D1's `storage_backends` table with a `UNIQUE(user_id, name)` constraint. The catalog stores URIs using the `r2://backendName/key` scheme (universal for all backend types). The Worker resolves the backend name to its configuration at credential-vend time via `getStorageBackendByNameOrId` (name lookup first, ID fallback for legacy URIs). DuckDB's `httpfs` is unaware of which backend it is reading from.

| Backend type | Proxy mechanism | Notes |
|---|---|---|
| `r2-bound` | S3 proxy → R2 Worker binding | Primary bucket in same Cloudflare account |
| `r2-s3compat` | S3 proxy → re-signed upstream S3 request | R2 in another account, or any S3-compatible service |
| `s3`, `gcs`, `azure` | Not yet implemented | Deferred to a later stage |
| `https` | Passthrough (domain allowlist check) | Publicly accessible data |

| Operation | Mechanism |
|---|---|
| ETL Worker writes (primary R2) | Native Worker binding — direct R2 access |
| ETL Worker writes (other backends) | `fetch()` with credentials from D1 |
| Browser reads / writes / lists storage | S3 proxy (`/api/storage/s3proxy`) with KV-backed proxy credentials; Worker forwards to real backend |
| Catalog and credential operations | Proxied through Worker; small payloads |

Writable URLs are only resolved for URIs matching the user's namespace and expected schema. The Worker rejects out-of-namespace requests before resolving. Adding a new storage backend requires a resolver case in the Worker proxy and a row in `storage_backends` — no catalog schema changes or browser changes required.

## Design Principles

- **Browser is the compute boundary.** Query execution, transform jobs, and data compaction all run in DuckDB-WASM in the browser. Raw data never passes through a central compute server.
- **Two DO classes with distinct jobs.** The catalog DO holds persistent warehouse state. The session DO is ephemeral — no storage, exists only to route MCP queries.
- **D1 for credentials and backend config only.** The catalog DO owns all warehouse metadata. D1 is a credential vault and storage backend registry, not a catalog.
- **Load jobs are always runnable. Transform jobs are conditionally runnable.** Load jobs have no browser dependency. Transform jobs queue until a browser session claims them.
- **Trigger-on-commit, not a DAG scheduler.** The catalog DO fires transform jobs reactively. Chains work naturally — a transform's completion commit triggers its own downstream transforms.
- **AI-first authoring.** Dashboards and analyses are built conversationally with Claude, then submitted as validated artifacts.
- **Storage is backend-agnostic.** The catalog stores URIs, not R2 keys. The Worker proxy resolves URIs to HTTPS URLs at access time. The browser and DuckDB never know which storage backend they are talking to. New backends are added by implementing a resolver case in the Worker proxy and registering a row in `storage_backends` — no catalog or browser changes required.
- **Encrypted at rest.** Data source credentials and storage backend config are encrypted in D1; only Workers decrypt them at request time. The browser never sees raw credentials.
- **Control plane through the Worker, data plane direct.** The Worker proxy handles auth, metadata, and credential operations. Large data transfers go browser↔storage directly via Worker-resolved URLs.
- **Cloudflare-native by default, not by constraint.** R2 is the primary storage backend but not the only one. Workers, D1, Durable Objects, and Pages do the orchestration; the data layer is replaceable.

## Open Questions

- Validation model for user-submitted dashboard artifacts (CSP, sandboxing approach, allowed React APIs)
- Whether to surface pending transform jobs in the UI with progress indicators or run them silently in the background
- Compaction granularity — per-sync, per-day, or per-month Parquet files as the default partition scheme
- Whether to expose time-travel queries (querying a table at a past commit ID) via the MCP server or only in the browser UI
