# Personal data warehouse — build plan

Each stage produces something functional and testable independently. Stages 1–3 are the foundation; 4–6 can be parallelised; 7 and 8 depend on 5 and 6 but not each other; 9 onward builds on the complete stack.

## Implementation status

| Stage | Description | Status |
|---|---|---|
| Auth (from Stage 2) | OAuth 2.0 + JWT worker, D1 schema | ✅ Done |
| Stage 1 | Skeleton with one working data path | ✅ Done |
| Stage 2 (remainder) | Credential storage, storage backends, settings UI | ✅ Done |
| HTTP data source | `http` credential type + `http-ds://` URI scheme + test UI | ✅ Done |
| Storage write path | `COPY TO 'r2://…'` and `COPY TO 'r2-s3compat://…'` from DuckDB WASM | ✅ Done |
| Stage 3 | Catalog DO | ✅ Done |
| Stage 4 | Load jobs: cron-triggered HTTP→storage ETL with catalog commit | ✅ Done |
| URI unification | `r2://name/key` for both backend types; name-based resolution; `UNIQUE(user_id, name)` | ✅ Done |
| Storage backend edit | `GET`/`PATCH /api/storage-backends/:id`; `EditBackendDialog` in settings UI | ✅ Done |
| Stage 5–10 | See below | Not started |

**Note on Stage 1 + Stage 2 storage resolution (updated — S3 proxy + URI unification):** The original per-key JWT token flow (`POST /api/storage/resolve`, `/api/storage/obj/:token`, `/api/storage/r2s3compat/obj/:token`) has been replaced by an S3-compatible proxy. `POST /api/storage/proxy-credentials` vends short-lived `{ accessKeyId, secret, endpoint, region, bucket }` credentials stored in `PROXY_CREDS_KV` with TTL. The frontend calls `acquireProxyCred()` to get a credential and `buildS3Secret()` to build a DuckDB `CREATE OR REPLACE SECRET` statement; all storage operations (GET, HEAD, PUT, ListObjectsV2) then flow through `GET|HEAD|PUT /api/storage/s3proxy/:bucket/*key` on the Worker (implemented in `src/storage/router.ts`), which forwards to the real backend (R2 binding for `r2-bound`, re-signed upstream S3 for `r2-s3compat`). This enables DuckDB `COPY TO … PARTITION_BY` (multiple PUT paths not known in advance) and `read_parquet('…/**/*.parquet', hive_partitioning=true)` (ListObjectsV2 to discover partition files). No CORS policy on the upstream bucket is needed. `POST /api/storage/resolve` is retained for `http-ds://` URI resolution only.

The URI scheme has been unified: `r2://backendName/key` now works for both `r2-bound` and `r2-s3compat` backends. The Worker resolves the backend name via `getStorageBackendByNameOrId` (name lookup first, ID fallback for legacy `r2-s3compat://id/key` URIs). A `UNIQUE(user_id, name)` constraint (migration 0006) ensures names are unambiguous. Special names `r2-bound` and `data-shack` route to the Worker's R2 binding directly. Keys are `decodeURIComponent`-decoded before dispatch to handle percent-encoded characters in Hive partition paths (e.g. `col%3Dvalue` → `col=value`). Storage backends can be renamed and edited via `GET`/`PATCH /api/storage-backends/:id` and the `EditBackendDialog` in the Settings UI.

**Note on HTTP data source (direct query alternative to Stage 4 ETL):** Rather than building the Akahu ETL worker first (Stage 4), a direct-query path was implemented that allows DuckDB to read from HTTP APIs in real time. A generic `http` credential type stores a base URL, configurable headers (with `{{variable}}` template interpolation), and variables in D1. The `http-ds://credentialId/path` URI scheme plugs into the existing `POST /api/storage/resolve` pipeline — DuckDB queries like `SELECT * FROM read_json('http-ds://cred_xxx/accounts') LIMIT 10` work transparently. The Worker signs a short-lived token that DuckDB uses to fetch through the proxy, which decrypts credentials and injects auth headers at request time. A test dialog in the Settings UI lets you call any HTTP data source path and see the raw response. This replaces the separate `akahu` credential type and covers the Akahu use case without requiring a cron-triggered ETL worker or catalog DO.

**Note on Stage 3 (Catalog DO):** The core catalog is fully implemented: `CatalogDO` with SQLite schema (`tables`, `snapshots`, `commits`), four Worker endpoints (`GET /catalog/tables`, `GET /catalog/snapshots/:table`, `POST /catalog/commit`, `PATCH /catalog/snapshots/:id`), browser auto-registration of DuckDB views from the catalog on startup, and a full Catalog management UI for committing snapshots and editing existing ones. The `format` field on snapshots is supported, with an `ALTER TABLE ADD COLUMN` migration applied in the DO constructor for existing instances. The `jobs`/`triggers` tables and WebSocket broadcast-on-commit are deferred to Stages 5 and 7.

Auth was built first to establish the security boundary before any data flows through the system. All subsequent stages build on top of this foundation — see [Stage 2](#stage-2--auth-and-credential-storage) for what's done and what remains.

---

## Stage 1 — Skeleton with one working data path

**Goal:** A browser tab can run a SQL query against real data in object storage.

- Cloudflare Pages frontend with DuckDB-WASM initialised
- Worker proxy with a single endpoint: accept a list of storage URIs, resolve them to readable HTTPS URLs, return to browser (see [Storage access pattern](#storage-access-pattern))
- No auth yet — hardcode a dev user
- No catalog yet — browser specifies URIs directly in a dev UI text field
- Write one static NDJSON file to R2 by hand; read it with `read_json()` in the browser

> **Note:** Even at this stage, the Worker proxy should accept a URI (`r2://bucket/key`) rather than a bare R2 key. This keeps the abstraction clean from the start and avoids a schema migration in Stage 3.

**Test:** DuckDB-WASM loads, `httpfs` reads from a resolved storage URL, Worker URI resolution and signing logic is correct, CORS is configured between Pages and Workers.

---

## Stage 2 — Auth and credential storage

**Goal:** The warehouse is yours, not anyone's.

### ✅ Auth layer — done (built ahead of Stage 1)

Implemented as a standalone Cloudflare Worker with D1, ahead of Stage 1, to establish the security boundary before any data paths are built.

- Google OAuth 2.0 provider with PKCE (RFC 7636)
- Dynamic Client Registration (RFC 7591) — Claude.ai registers itself as a public client
- Protected-resource metadata (RFC 9728)
- D1 schema: `users`, `oauth_identities`, `oauth_states`, `oauth_clients`, `oauth_codes`, `oauth_refresh_tokens`
- HMAC-HS256 JWTs (1 h access tokens), rotating refresh tokens (30 d), stored as SHA-256 hashes
- Bearer JWT middleware on all protected routes
- 43 vitest tests via `@cloudflare/vitest-pool-workers`

### Remaining

- D1 tables for credential and storage backend storage:
  - `credentials` — encrypted source API credentials (Akahu token, OAuth tokens, etc.)
  - `storage_backends` — encrypted storage config and credentials (bucket, region, endpoint, access keys); one row per backend
- Worker proxy validates the Bearer JWT on every request before resolving storage URIs or decrypting credentials
- Minimal settings UI to add a credential or storage backend by name and type

**Test:** Credentials and storage backend config survive a round-trip through D1 encrypted and decrypted correctly.

---

## Stage 3 — Catalog DO ✅ Done

**Goal:** The browser discovers what tables exist rather than being told.

### ✅ Implemented

- `CatalogDO` with SQLite schema: `tables`, `snapshots`, `commits`; per-user DO isolation via `env.CATALOG.idFromName(userId)`
- Snapshot records store fully-qualified URIs, `storage_backend` ID, `access_mode`, optional `format`, and timestamp:
  ```json
  {
    "uri": "r2://my-bucket/transactions/staging/akahu-2026-05-19.ndjson",
    "storageBackend": "primary-r2",
    "accessMode": "signed",
    "format": "ndjson"
  }
  ```
- Worker endpoints: `GET /catalog/tables`, `GET /catalog/snapshots/:table`, `POST /catalog/commit`, `PATCH /catalog/snapshots/:id`
- `PATCH` supports updating `uri` and/or `format` on an existing snapshot (e.g. to correct a wrong URI or override auto-detected format)
- Browser (QueryPanel) loads the table list from the catalog on startup; registers DuckDB views from snapshot URIs, marks failed registrations with a ⚠ badge rather than blocking the whole load
- Catalog management UI (CatalogPanel): URI convention callout, commit form with backend autocomplete, inline edit for URI and format per snapshot
- `format` column added via `ALTER TABLE ADD COLUMN` in the DO constructor (idempotent migration for existing instances)
- 10 integration tests in `test/catalog.test.ts`

### Deferred

- `jobs` and `triggers` tables (Stage 7 — transform job queue)
- WebSocket broadcast on commit (Stage 5 — live sync)

---

## Stage 4 — Load jobs ✅ Done

**Goal:** Real data flows in automatically.

> **Alternative already built:** Akahu data can already be queried directly from DuckDB via the `http-ds://` URI scheme. Stage 4 adds a cron-triggered ETL path that snapshots data to R2 for catalog-tracked, time-travel-capable storage. The two approaches are complementary — direct query for ad-hoc exploration, ETL for reliable scheduled ingestion.

### ✅ Implemented

- `load_jobs` D1 table: `id`, `user_id`, `name`, `credential_id`, `storage_backend_id`, `table_name`, `table_path`, `http_path`, `http_method`, `format`, `cron_schedule`, `next_run_at`, `last_run_at`, `last_error`, `enabled`
- CRUD API: `GET/POST/PATCH/DELETE /api/load-jobs`, `POST /api/load-jobs/:id/trigger`
- `scheduled()` handler: queries due jobs, advances `next_run_at` (claim), enqueues to `LOAD_JOB_QUEUE`
- `queue()` consumer: fetches job, runs `runHttpLoadJob`, persists `last_run_at`/`last_error`/`next_run_at`; retries on failure (up to 3 times)
- `runHttpLoadJob` (`src/loaders/http.ts`): HTTP fetch → `FixedLengthStream` for streaming or `ArrayBuffer` for buffering → R2 write (bound or s3-compat) → catalog commit
- `table_path` field: optional custom storage directory (relative to user namespace for `r2-bound`, relative to bucket root for `r2-s3compat`)
- Load Jobs UI panel: list, create, edit, delete, "Run now" trigger with status feedback
- `r2-bound` option in Settings → Storage Backends form
- 6 new unit tests in `test/loader.test.ts`, 27 new integration tests in `test/load-jobs.test.ts`

---

## Stage 5 — WebSocket broadcast and live sync

**Goal:** The browser learns about new data without polling.

- Catalog DO handles WebSocket connections from browser tabs; broadcasts on every commit
- Browser opens a WebSocket to the catalog DO on startup; re-resolves affected table views on commit
- Sidebar indicator flashes on commit

**Test:** Open two browser tabs. Trigger a manual catalog commit. Both tabs update within a second. Trigger a cron Akahu load — browser updates without a reload.

---

## Stage 6 — Session DO and MCP server

**Goal:** Claude can query the warehouse.

- Session Durable Object: accepts a WebSocket from the browser, registers the session, forwards inbound query requests to the browser and streams results back
- MCP server (Worker) with two initial tools:
  - `get_warehouse_schema` — reads from catalog DO, no browser session needed
  - `run_query` — routes through session DO, requires an active browser tab

**Test:** Connect Claude Desktop to the MCP server. Ask Claude what tables exist — should answer without a browser tab open. Open a tab, ask Claude to query transactions — should return real results. Close the tab, ask Claude to query — should report no session available rather than hanging.

---

## Stage 7 — Compaction (first transform job)

**Goal:** The query format improves automatically.

- Transform job queue in the catalog DO: `jobs` table with `type`, `status`, `requires_browser`, `watches`
- Trigger-on-commit logic: after each load commit, check `triggers` table and enqueue matching pending transform jobs
- Session DO job dispatch: on browser connect, check for pending transform jobs and forward over session WebSocket
- Browser-side transform runner:
  1. Receives job spec including input URIs and output URI
  2. Resolves each input URI to a readable HTTPS URL via the Worker proxy storage resolver
  3. Registers DuckDB views per input table using the resolved URLs
  4. Runs `COPY … TO … (FORMAT PARQUET)` query — ✅ write URL resolution and DuckDB WASM write path already implemented (steps 5–6 below are done)
  5. Requests a writable URL for the output URI from the Worker proxy (`method: "PUT"` in `POST /api/storage/resolve`) — ✅ Done for `r2://` and `r2-s3compat://`
  6. Writes Parquet directly to the storage backend — ✅ Done (`r2://` via virtual FS + fetch, `r2-s3compat://` via DuckDB native S3 httpfs)
  7. Commits result URI to catalog DO
- Re-claim logic: if session drops mid-job, session DO resets job to `pending`
- Compaction trigger added for the `transactions` table

**Test:** Trigger an Akahu load. Verify compact job appears as pending. Open a browser tab. Verify job is claimed and executed. Verify catalog has a Parquet snapshot URI replacing NDJSON staging URIs. Close tab mid-compaction, reopen — verify job re-runs cleanly.

---

## Stage 8 — Dashboard platform

**Goal:** Analyses persist beyond a Claude conversation.

- `dashboards` table in D1 (dashboards don't need the catalog DO's consistency guarantees): stores React artifact source, bound SQL queries, title
- MCP tool `submit_dashboard`: Claude calls this after iterating on a dashboard with the user; Worker validates artifact for XSS risks before persisting
- Dashboard viewer in Pages frontend: loads and renders persisted dashboards, subscribes to catalog DO WebSocket for relevant tables, re-runs bound queries on commit

**Test:** Have a conversation with Claude that produces a spending breakdown dashboard. Submit it via MCP. Navigate to the dashboard viewer — renders with live data. Trigger an Akahu sync — dashboard updates automatically.

---

## Stage 9 — Second data source and cross-source joins

**Goal:** The warehouse earns the "integration" in data integration.

- Google Sheets load job: OAuth flow handled in the browser (redirect + token handoff to Worker, stored in D1); Sheets ETL Worker on a cron, same pattern as Akahu
- Derived table `monthly_spending`: transform job with `watches: ['transactions', 'budget']`, `policy: 'all'` — fires only after both sources have fresh commits
- Multi-input transform runner: resolves all watched tables to current snapshot keys, registers each as a named DuckDB view, runs join SQL against plain table names

**Test:** Edit a budget figure in Google Sheets. Wait for the next cron. Verify the derived table updates. Verify the `monthly_spending` dashboard reflects the change. Verify the transform does not fire until both sources have committed.

---

## Stage 10 — MCP tools for job management

**Goal:** Claude can configure the warehouse, not just query it.

- `create_load_job` — source type, config, schedule, output format, target table, optional downstream transform trigger
- `create_transform_job` — input tables, SQL or named transform type, output table/key, Parquet parameters
- `list_etl_jobs` — active job definitions, schedules, last run times
- `pause_etl_job` — disable without deleting
- `list_data_sources` — available connectors and required config fields

**Test:** Ask Claude to set up a new Akahu account sync from scratch in a single conversation. Verify it creates the load job, compaction trigger, and correct credential reference without any manual config.

---

## Storage access pattern

Two patterns coexist — control plane through the Worker, data plane direct with Worker-resolved URLs. The browser always receives a plain HTTPS URL and hands it to DuckDB's `httpfs`; backend multiplexing is entirely in the Worker.

### Storage backends

Backends are configured in D1's `storage_backends` table and referenced by ID in catalog snapshot records. The Worker proxy resolves a URI to a readable or writable HTTPS URL based on the backend type:

| Backend type  | Read / write / list mechanism                        | Status      |
| ------------- | ---------------------------------------------------- | ----------- |
| `r2-bound`    | S3 proxy → R2 Worker binding                         | ✅ Done     |
| `r2-s3compat` | S3 proxy → re-signed upstream SigV4 request          | ✅ Done     |
| `s3`          | S3 proxy → re-signed upstream SigV4 request          | Not started |
| `gcs`         | S3 proxy → signed URL via service account            | Not started |
| `azure`       | S3 proxy → SAS token                                 | Not started |
| `https`       | Passthrough (domain allowlist check; read-only)      | Not started |

### Data plane (large transfers)

Used for Parquet and NDJSON files where Worker memory limits (128MB) and CPU time limits would be a real constraint.

| Operation               | Who uses it                | Notes                                                   |
| ----------------------- | -------------------------- | ------------------------------------------------------- |
| Read snapshots          | Browser (query execution)  | Worker resolves URI → short-lived HTTPS URL             |
| Read staging files      | Browser (transform input)  | Same                                                    |
| Write compacted Parquet | Browser (transform output) | Worker validates URI prefix before issuing writable URL |

The Worker validates URI prefixes before issuing any writable URL — the browser can only write to locations matching the user's namespace and expected schema (`transactions/staging/…`, `transactions/compacted/…`).

### Control plane (small payloads)

Used where Worker overhead is negligible and centralised auth is valuable.

| Operation                                | Notes                                                              |
| ---------------------------------------- | ------------------------------------------------------------------ |
| Catalog DO interactions                  | Table list, snapshot metadata, commits                             |
| Credential and backend config read/write | Encrypted in D1, decrypted by Worker                               |
| Job queue interactions                   | Enqueue, claim, complete                                           |
| URI resolution                           | `POST /api/storage/resolve` — returns HTTPS URL for data-plane use |

### ETL Workers

For the primary R2 backend, ETL Workers use the native R2 Worker binding directly. For other backend types, they use `fetch()` with credentials looked up from D1. The catalog and browser are unaware of which mechanism was used — they see only the URI in the snapshot record.

---

## Key architectural constraints to preserve

- **Browser is the compute boundary.** Query execution and transform jobs run in DuckDB-WASM in the browser. Raw data never passes through a central compute server.
- **Two DO classes with distinct jobs.** The catalog DO holds persistent state (tables, snapshots, commits, job queue). The session DO is ephemeral (pairs MCP requests with browser tabs, no storage).
- **Load jobs are always runnable.** They have no browser dependency. Transform jobs are conditionally runnable — they queue until a browser session claims them.
- **Trigger-on-commit, not a DAG scheduler.** The catalog DO fires transform jobs reactively after commits rather than on a separate schedule. Chains work naturally — a transform's completion commit triggers its own downstream transforms.
- **D1 for credentials and storage backend config only.** The catalog DO owns all warehouse metadata. D1 is a credential vault and backend registry, not a catalog.
- **Storage is backend-agnostic.** The catalog stores URIs, not R2 keys. The Worker proxy resolves URIs to HTTPS URLs at access time. The browser and DuckDB never know which storage backend they're talking to. New backends are added by implementing a resolver case in the Worker proxy and registering a row in `storage_backends` — no catalog or browser changes required.
