# Personal Data Warehouse

A personal data integration platform built on Cloudflare that brings your data together for querying, analysis, and dashboarding — with a privacy-preserving twist: the compute engine runs in your own browser.

## What's built

The auth layer was implemented first to establish the security boundary before any data paths are built.

| Component | Status |
|---|---|
| OAuth 2.0 worker (Google, PKCE, DCR, JWT, refresh rotation) | ✅ Done |
| D1 schema (users, oauth_identities, oauth tables) | ✅ Done |
| Browser compute engine (DuckDB-WASM + WebSocket) | Not started |
| Worker proxy (storage resolver, credential vault) | Not started |
| Catalog Durable Object | Not started |
| Session Durable Object + MCP server | Not started |
| ETL workers (Akahu, Google Sheets) | Not started |
| Dashboarding platform | Not started |

See [`build-plan.md`](./build-plan.md) for the full sequenced plan.

## Architecture Overview

The system is built on Cloudflare's stack (Workers, D1, R2, Durable Objects, Pages) with OAuth 2.0 (Google) and JWT-based authentication. SQL execution happens in a **browser-local DuckDB-WASM instance** rather than on the server. The server orchestrates; your browser computes.

The key structural insight is a clean split between the **control plane** (all traffic through the Worker proxy) and the **data plane** (browser reads and writes object storage directly via Worker-resolved URLs). Large Parquet files never pass through a Worker. Storage backends are pluggable — the catalog records URIs, the Worker proxy resolves them to HTTPS URLs at access time, and DuckDB's `httpfs` is unaware of which backend it's talking to.

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

- `tables` — table definitions and schemas
- `snapshots` — every storage URI that constitutes a table, with backend ID, access mode, row count, format, and timestamp
- `commits` — a log of every change, enabling time-travel queries
- `jobs` — the pending/claimed/done queue for transform jobs
- `triggers` — the mapping from input tables to downstream transform jobs

All writes to the catalog are processed single-threadedly inside the DO isolate, eliminating race conditions between concurrent ETL Workers. After every commit, the DO broadcasts a notification to all connected browser tabs over WebSocket.

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

- `get_warehouse_schema` — table list, schemas, snapshot metadata, last sync times
- `list_etl_jobs` — active job definitions and schedules
- `create_load_job` — define a new source connector and cron schedule
- `create_transform_job` — define a derived table with its SQL and input dependencies
- `pause_etl_job` — disable a job without deleting it
- `list_data_sources` — available connectors and required config
- `run_query` — execute SQL; requires an active browser session
- `submit_dashboard` — persist a Claude-authored dashboard artifact

### Dashboarding Platform

Dashboards are React artifacts with props bound to SQL queries. The authoring workflow:

1. The user iterates on visualisations and calculations with Claude inside Claude.ai, with live warehouse data via the MCP server and browser session.
2. Once satisfied, Claude calls `submit_dashboard` via MCP.
3. The Worker proxy validates the artifact for XSS risks before persisting it to D1.
4. The dashboard viewer in the Pages frontend loads persisted dashboards, subscribes to the catalog DO WebSocket for the tables their queries touch, and re-runs bound queries automatically on commit.

## Storage Access Pattern

Storage backends are configured in D1's `storage_backends` table and referenced by ID in catalog snapshot records. The catalog stores URIs (`r2://bucket/key`, `s3://bucket/key`, `https://…`); the Worker proxy resolves them to plain HTTPS URLs at access time. DuckDB's `httpfs` is unaware of which backend it is reading from.

| Backend type | Mechanism | Notes |
|---|---|---|
| `r2-bound` | R2 Worker binding → signed URL | Primary bucket in same Cloudflare account |
| `s3` | SigV4-signed URL | AWS S3 or any S3-compatible endpoint |
| `r2-s3compat` | SigV4-signed URL (R2 S3 endpoint) | R2 in another account |
| `gcs` | Signed URL via service account | Google Cloud Storage |
| `azure` | SAS token URL | Azure Blob Storage |
| `https` | Passthrough (domain allowlist check) | Publicly accessible data |

| Operation | Mechanism | Reason |
|---|---|---|
| ETL Worker writes (primary R2) | Native Worker binding | Direct R2 access; no credentials exposed |
| ETL Worker writes (other backends) | `fetch()` with credentials from D1 | Binding only works for same-account R2 |
| Browser reads Parquet/NDJSON | Worker-resolved HTTPS URL | Files can be large; avoids Worker memory limits |
| Browser writes compacted Parquet | Worker-resolved writable URL | Same; Worker validates URI prefix before resolving |
| Catalog and credential operations | Proxied through Worker | Small payloads; centralised auth check is valuable |

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
