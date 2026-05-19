# Personal data warehouse — build plan

Each stage produces something functional and testable independently. Stages 1–3 are the foundation; 4–6 can be parallelised; 7 and 8 depend on 5 and 6 but not each other; 9 onward builds on the complete stack.

## Implementation status

| Stage | Description | Status |
|---|---|---|
| Auth (from Stage 2) | OAuth 2.0 + JWT worker, D1 schema | ✅ Done |
| Stage 1 | Skeleton with one working data path | ✅ Done |
| Stage 2 (remainder) | Credential storage, storage backends, settings UI | ✅ Done |
| Stage 3 | Catalog DO | Not started |
| Stage 4–10 | See below | Not started |

**Note on Stage 1 + Stage 2 storage resolution:** The `POST /api/storage/resolve` endpoint and the `GET /api/storage/obj/:token` proxy are working end-to-end for `r2://` URIs against the bound R2 bucket. However, URI resolution does not yet look up the `storage_backends` table — the bucket name in the URI is validated syntactically but not matched against a configured backend row. Full backend dispatch (choosing between `r2-bound`, `s3`, `gcs`, etc. based on D1 config) will be wired in Stage 3 when the catalog DO's snapshot records tie URIs to specific backend IDs.

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

## Stage 3 — Catalog DO

**Goal:** The browser discovers what tables exist rather than being told.

- Catalog Durable Object with SQLite schema: `tables`, `snapshots`, `commits`
- Snapshots store fully-qualified URIs rather than bare R2 keys, plus a `storage_backend` ID and `access_mode`:
  ```json
  {
    "uri": "r2://my-bucket/transactions/staging/akahu-2026-05-19.ndjson",
    "storageBackend": "primary-r2",
    "accessMode": "signed"
  }
  ```
- Worker proxy storage resolver endpoint: receives a URI, looks up the backend type from `storage_backends` in D1, returns a readable HTTPS URL (signed URL for R2/S3/GCS, SAS token for Azure, passthrough for public HTTPS)
- Worker proxy endpoints: `GET /catalog/tables`, `GET /catalog/snapshots/:table`, `POST /catalog/commit`
- Manually insert a table definition and snapshot URI pointing at the Stage 1 file
- Browser loads the table list from the catalog on startup; query runner resolves table URIs to HTTPS URLs via the Worker proxy, registers DuckDB views, then runs SQL

**Test:** Catalog DO persists across Worker restarts. View registration correctly resolves URIs to readable URLs. Mixed-format snapshots (NDJSON and Parquet) both work as views. Swapping a snapshot's backend ID in D1 and re-resolving returns a URL from the new backend.

---

## Stage 4 — First load job (Akahu)

**Goal:** Real data flows in automatically.

- Akahu ETL Worker: cron-triggered, reads Akahu API credential from D1 via Worker proxy, calls Akahu API, writes NDJSON to the primary storage backend, commits snapshot URI to catalog DO
- Cursor tracking: last-fetched timestamp stored in D1 alongside the credential
- The load job definition records which `storage_backend` ID to write to — the Worker looks up the backend config from D1 to determine how to write (R2 binding for bound R2, `fetch()` with credentials for S3-compatible or external backends)

> **ETL writes:** For the primary R2 backend, ETL Workers use the native R2 Worker binding — no signed URL needed. For any other backend type, the Worker uses `fetch()` with credentials from D1. The abstraction is in the Worker; the catalog and browser don't need to know which mechanism was used.

**Test:** Cron fires. Akahu API response is correctly written as NDJSON. Catalog commit registers the snapshot URI. Browser picks up the new snapshot on manual reload (WebSocket broadcast not yet built — that's fine).

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
  4. Runs `COPY … TO … (FORMAT PARQUET)` query
  5. Requests a writable URL for the output URI from the Worker proxy (signed PUT URL for R2/S3, SAS token for Azure, etc.) — see [Storage access pattern](#storage-access-pattern)
  6. Writes Parquet directly to the storage backend
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

| Backend type  | Read resolution                       | Write resolution                     |
| ------------- | ------------------------------------- | ------------------------------------ |
| `r2-bound`    | Signed GET URL via R2 Worker binding  | Signed PUT URL via R2 Worker binding |
| `s3`          | SigV4-signed GET URL                  | SigV4-signed PUT URL                 |
| `r2-s3compat` | SigV4-signed GET URL (R2 S3 endpoint) | SigV4-signed PUT URL                 |
| `gcs`         | Signed GET URL (service account)      | Signed GET URL (service account)     |
| `azure`       | SAS token URL                         | SAS token URL                        |
| `https`       | Passthrough (domain allowlist check)  | Not supported                        |

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
