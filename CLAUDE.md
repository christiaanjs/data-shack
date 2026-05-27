# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Bootstrap a new environment

```bash
./scripts/bootstrap.sh                   # production (default)
./scripts/bootstrap.sh --env staging     # staging
./scripts/bootstrap.sh --env local       # local dev (.dev.vars)
./scripts/bootstrap.sh --env production --deploy  # bootstrap + deploy in one step
```

The script:
1. Creates the D1 database (idempotent — skips if already exists) and patches `wrangler.toml`
2. Applies all D1 migrations
3. Walks you through creating a Google OAuth 2.0 Web Application credential (console link + prompt)
4. Generates a `JWT_SECRET` via `openssl`
5. Pushes all secrets to Cloudflare via `wrangler secret put` (or writes `.dev.vars` for local)

Requires: `wrangler` (or npx), `openssl`, `jq`.

## Pre-commit checklist

**Always run all three checks before every commit** — CI enforces the same checks and will fail otherwise:

```bash
npm test          # 234 vitest tests across 9 test files via @cloudflare/vitest-pool-workers
npm run typecheck # tsc for worker + tsc -p test/tsconfig.json
npm run lint      # biome check . (lint + format + import order)
```

**Never skip `npm run lint`.** Biome enforces formatting, import order, and lint rules across both the worker (`src/`) and frontend (`frontend/src/`). A clean lint check is required before every commit without exception. If lint fails, fix it first — auto-fix covers most issues:

```bash
npx biome check --fix --unsafe .
```

Frontend has its own typecheck (no test suite yet):

```bash
cd frontend && npm run typecheck
```

`aws4fetch` is a dev dependency used only in `test/proxy-s3client.test.ts` — it is not imported by any worker source file and will never appear in the Wrangler bundle.

## Repository structure

Two independent packages share this repo:

- **Root** (`src/`, `test/`, `migrations/`) — Cloudflare Worker (Hono + D1 + Wrangler)
- **`frontend/`** — Cloudflare Pages SPA (Preact + Vite)

They have separate `node_modules`, `package.json`, and `tsconfig.json`. The worker has no dependency on the frontend and vice versa. Biome's `lint` runs from the root and covers both (`biome check .` traverses `frontend/src/` too).

## Worker architecture

**Entry point:** `src/index.ts` — Hono app with CORS middleware, `requireAuth` middleware, and two route groups: the OAuth router and authenticated endpoints.

**Auth flow:**
1. `authenticate()` in `src/auth/middleware.ts` checks for `X-Dev-Token` header first (when `ENABLE_DEV_AUTH=true`), then validates a Bearer JWT via `src/auth/jwt.ts` (HMAC-HS256). Audience is validated against `${issuer}/mcp` — tokens minted for other resources are rejected.
2. `verifyJwt` in `src/auth/jwt.ts` accepts an optional `expectedAud` parameter; when supplied, it rejects tokens where `payload.aud !== expectedAud`.
3. All OAuth endpoints live in `src/auth/oauth.ts` via `oauthRouter`. The flow: `/authorize/:provider` → Google OAuth → `/oauth/callback` → exchange code → issue MCP auth code → redirect to client → client POSTs to `/token` → receives JWT + refresh token.
4. Provider support is Google-only. Passing any other provider to `/authorize/:provider` returns `400 invalid_request`.

**Google Sheets credential OAuth flow:** `GET /connect/google-sheets?name=` (in `src/auth/oauth.ts`) stores OAuth state with `{ userId, credName, flow: 'google-sheets' }` and redirects to Google with Sheets scope + `access_type=offline`. The callback at `/oauth/callback` (shared with the MCP OAuth flow) detects `flow: 'google-sheets'`, stores the refresh token as a `google-sheets` credential in D1, and returns `popupResultHtml` — a self-closing HTML page that calls `window.opener.postMessage({ type: 'gscred-success', credentialName }, JSON.stringify(frontendOrigin))` then `window.close()`. The frontend opens the URL in a popup via `window.open`; a scoped `message` listener on the opener handles the result and refreshes the credentials list. A `setInterval` polls for popup closure to clean up the listener.

**D1 query layer:** `src/db/queries.ts` for user/identity operations, `src/db/oauth.ts` for OAuth table operations, `src/db/settings.ts` for credentials/storage backends, `src/db/load-jobs.ts` for load job CRUD. All SQL is in these files — no inline SQL elsewhere.

**User identity model:** Each user is their own tenant (no household concept). `oauth_identities` maps (provider, provider_id) → user. On login, the resolution order is: existing identity → link by verified email → create new user. New user creation is gated by `allowed_emails` — if the verified email is absent or not in that table, the OAuth callback returns 403. Existing users (identity already in DB) are always admitted. Email is nullable on `users` for existing accounts.

**Token lifetimes:** Access tokens 1 hour (JWT), refresh tokens 30 days (stored as SHA-256 hashes in D1, rotated on every use).

**Key D1 tables:** `users`, `oauth_identities`, `oauth_states`, `oauth_clients`, `oauth_codes`, `oauth_refresh_tokens`, `credentials`, `storage_backends`, `load_jobs`, `allowed_emails`. All timestamp columns are Unix milliseconds (`Date.now()`). `oauth_states` has a `credential_name` column (migration 0009) used to pass the credential name through the Google Sheets OAuth popup flow.

**Load jobs:** Cron-triggered ETL jobs. Each job has a `source_type` column (`'http'` or `'google-sheets'`) and a `source_config` JSON column. The `scheduled()` handler queries D1 for due jobs and enqueues `{ jobId }` messages to `LOAD_JOB_QUEUE`. The `queue()` consumer fetches the job and branches on `source_type`: `'http'` runs `runHttpLoadJob` from `src/loaders/http.ts` (HTTP fetch → R2/S3 write → catalog commit); `'google-sheets'` runs `runGoogleSheetsLoadJob` from `src/loaders/google-sheets.ts` (token refresh → Sheets API v4 fetch → NDJSON conversion → R2/S3 write → catalog commit, with a 50 MB buffer limit). Updates `last_run_at`/`last_error`/`next_run_at` in D1; retries on failure (up to `max_retries = 3`). `POST /api/load-jobs/:id/trigger` enqueues directly for on-demand runs. The PATCH handler reads the existing job first to preserve `source_type`/`source_config` when those fields are omitted from the request body.

**Session DO:** `src/session/do.ts` — pairs MCP query requests with an active browser tab. Uses `ctx.acceptWebSocket(server, [userId])` (hibernation API) so the DO sleeps between events. An in-memory `pendingQueries` map (keyed by `queryId`) holds `{ resolve, reject }` closures while awaiting a browser response — safe because active `POST /query` fetch handlers prevent hibernation. On browser connect, dispatches any pending transform jobs via `dispatchPendingJobs` (fetches `GET /jobs/pending` from catalog DO, sends each as `{ type: "transform_job", ... }` over the socket). On socket close, resets any `running` transform jobs back to `pending` via `POST /jobs/reset-pending`. `GET /session/status` returns the count of connected sockets; `POST /dispatch-jobs` can be called by the Worker to push freshly triggered jobs.

**MCP server:** `src/mcp/server.ts` — Streamable HTTP transport (MCP 2025-03-26 spec), mounted at `/mcp` on the main Hono app behind `requireAuth`. Four tools: `get_warehouse_schema` (fetches tables + snapshots from catalog DO — no browser session required), `list_data_sources` (lists HTTP credentials with their base URLs — no browser session required), `run_query` and `read_data` (both POST to the session DO's `/query` endpoint and await a DuckDB result from the browser).

**Catalog DO WebSocket and batch snapshot endpoint:** `GET /catalog/ws` (Worker, no `requireAuth` — auth via `Sec-WebSocket-Protocol` token) authenticates and forwards the upgrade to the catalog DO's `handleWebSocketUpgrade`, which registers tabs using `ctx.acceptWebSocket` (hibernation API). `POST /commit` broadcasts `{ type: "commit", table, snapshotId, uri, storage_backend, access_mode, format }` to all connected sockets via `ctx.getWebSockets()` after the transaction. `GET /catalog/snapshots-latest` (Worker, behind `requireAuth`) proxies to the DO's `getSnapshotsLatest`, which runs a single LEFT JOIN to return all tables with their latest snapshot in one request — used by `registerCatalogViews` instead of N+1 fetches.

**Transform jobs and triggers:** Managed entirely inside the catalog DO's SQLite. `transform_jobs` tracks `id, name, sql, output_table, output_uri, output_backend, format, status, requires_browser, last_completed_at`. `triggers` maps a set of watched tables to a job: `watches` is a JSON array string (e.g. `'["transactions","budget"]'`), `policy` is `'any'` (default — fires on any matching commit) or `'all'` (fires only when every watched table has a snapshot newer than `last_completed_at`). Status lifecycle: `idle → pending → running → done/failed`. On every `POST /commit`, the catalog DO queries `'any'` triggers via `json_each()` membership and `'all'` triggers by counting watched tables with no newer snapshot; qualifying jobs move to `pending`, and their IDs are returned in `{ triggeredJobIds }`. `completeJob` records `last_completed_at` for freshness tracking. The Worker's commit relay picks up `triggeredJobIds` in a `waitUntil` and calls `POST /dispatch-jobs` on the session DO. Worker REST API: `GET/POST/DELETE /api/transform-jobs`, `GET/POST/DELETE /api/triggers`. Browser execution lives in `frontend/src/sessionWs.ts`: receives `transform_job`, awaits `getCatalogReady()` (so the job sees freshly committed snapshots), sends `job_claimed`, acquires proxy credentials for the output backend, runs the COPY TO SQL in DuckDB, then sends `job_complete` or `job_error`. The Session DO receives `job_complete`, looks up the job spec to get the output URI, commits it to the catalog DO, and marks the job `done`.

**S3-compatible storage proxy:** All storage routes live in `src/storage/router.ts` (a Hono sub-router mounted at `/api/storage` in `src/index.ts`). `POST /api/storage/proxy-credentials` (behind `requireAuth`) vends a short-lived `{ accessKeyId, secret, endpoint, region, bucket }` credential stored in `PROXY_CREDS_KV` with TTL. `GET|HEAD|PUT|OPTIONS /api/storage/s3proxy/:bucket/*key` (no `requireAuth` — the `accessKeyId` from the AWS4 `Authorization` header is the auth) forwards to the real backend: R2 binding for `r2-bound`, re-signed upstream S3 request for `r2-s3compat`, or Google Sheets API for `google-sheets` backends. For `google-sheets`: GET refreshes the OAuth token, fetches from the Sheets API v4 values endpoint, and returns rows as a JSON array (so DuckDB can use `read_json`); the sheet tab is determined by stripping the extension from the S3 key. PUT accepts JSON array or NDJSON, converts to `string[][]`, and writes via the Sheets values API; the response always includes `ETag: "gsheets"` so DuckDB's S3 client doesn't throw. A `GET` with `?list-type=2` triggers `R2.list()` and returns S3 `ListBucketResult` XML (R2 backends only). All responses carry CORS headers. The frontend (`frontend/src/storage.ts`) calls `acquireProxyCred()` and `buildS3Secret()` to configure DuckDB's httpfs via `CREATE OR REPLACE SECRET`.

**URI scheme:** `r2://backendName/key` is the universal URI for both backend types. `r2-s3compat://id/key` still works for backwards compatibility. The Worker resolves the bucket segment (backend name or ID) to a storage backend via `getStorageBackendByNameOrId` in `src/db/settings.ts` (name lookup first, ID fallback). Special names `r2-bound` and `data-shack` map to the Worker's R2 binding directly. The `bucket` field returned in proxy credentials is the backend name (not ID), so DuckDB can scope multiple `CREATE SECRET` entries when a query touches several backends. A `UNIQUE(user_id, name)` constraint (migration 0006) ensures name-based resolution is unambiguous. Keys from DuckDB are `decodeURIComponent`-decoded before R2/upstream dispatch to handle percent-encoded characters in Hive partition paths (e.g. `created_date%3D2026-05-21` → `created_date=2026-05-21`).

**Storage backend edit:** `GET /api/storage-backends/:id` returns the decrypted config for pre-filling an edit form. `PATCH /api/storage-backends/:id` updates `name` and/or `config` with the same validation as `POST` (reserved name check, length, no `/`, UNIQUE → 409). `updateStorageBackend()` in `src/db/settings.ts` builds the dynamic `UPDATE` statement. The `EditBackendDialog` in `SettingsPanel.tsx` fetches config on open and PATCHes on save.

## Frontend architecture

Single-file auth client in `frontend/src/auth.ts` — handles DCR (Dynamic Client Registration), PKCE code verifier generation, token exchange, auto-refresh (5-minute buffer), and token storage in `localStorage`/`sessionStorage`.

`frontend/src/App.tsx` is an auth state machine: `null` (loading) → `false` (login screen) → `true` (authenticated). On load it either handles the `/callback` route (token exchange) or checks for an existing access token. After authentication it calls `GET /me` to resolve `userId`. Catalog state (`catalogTables`, `catalogLoading`, `catalogError`, `catalogFailed`, `dbReady`, `dbError`) is lifted here and persists across tab switches. A `catalogReadyRef` tracks a chained promise for all in-flight view refreshes; `getCatalogReady()` returns it so transform jobs can await catalog freshness. An amber `hasNewData` dot in the navbar flashes for 3 s on each catalog commit.

`VITE_DEV_TOKEN` in the frontend environment skips OAuth entirely — the token is sent as `X-Dev-Token` on every request.

`frontend/src/catalogWs.ts` — `connectCatalogWs()` opens a WebSocket to `GET /catalog/ws` after auth. On each `commit` message, creates a `refreshSingleView` promise, chains it with `Promise.all` onto the accumulated refresh promise, then calls `onCommit(event, accumulatedPromise)`. Reconnects on close with 5 s backoff; eager-reconnects on tab visibility restore; removes the `visibilitychange` listener in `close()`.

`frontend/src/sessionWs.ts` — connects to the session DO WebSocket (`GET /session/ws`) after auth. Config includes `getCatalogReady`; `socket.onmessage` awaits it before processing any message. Handles three inbound message types: `query` (runs SQL in DuckDB, streams row batches back), `transform_job` (awaits catalog ready, sends `job_claimed`, acquires proxy credentials, runs COPY TO SQL, sends `job_complete` or `job_error` — no longer calls `registerCatalogViews`), `job_status` (server broadcast of running/done/failed — updates UI across all connected tabs and machines). The Session DO receives `job_complete`, looks up the job spec, commits the output URI to the catalog DO, and marks the job `done`. Status indicators surface in App.tsx.

`frontend/src/catalogViews.ts` — `registerCatalogViews` uses `GET /catalog/snapshots-latest` (single request, LEFT JOIN) instead of N+1 fetches; batch-resolves `http-ds://` URIs via a single `POST /api/storage/resolve` before creating views; `refreshSingleView` re-creates a single view for incoming commit events; shared private `registerView` with `preResolvedUrl?` param avoids per-table round-trips. Tables that fail are reported without blocking the others.

`frontend/src/QueryPanel.tsx` — receives catalog and DuckDB state as props from App; no longer manages its own DuckDB singleton or catalog fetch; state persists across tab switches.

## Local development

**Worker:**

```bash
# Required .dev.vars (gitignored):
# GOOGLE_CLIENT_ID=<local Google OAuth app>
# GOOGLE_CLIENT_SECRET=<local Google OAuth app>
# JWT_SECRET=<any 32+ char string>
# ALLOWED_ORIGIN=http://localhost:5173
# ENABLE_DEV_AUTH=true
# DEV_TOKEN=some-local-secret
# DEV_USER_ID=usr_local

npm run dev          # Worker on http://localhost:8787
npm run migrate:local  # Apply migrations to local D1
```

**Frontend:**

```bash
# Required frontend/.env.local (gitignored):
# VITE_WORKER_URL=http://localhost:8787
# VITE_DEV_TOKEN=some-local-secret   # optional, skips OAuth
# VITE_DUCKDB_LOG_LEVEL=DEBUG        # optional: DEBUG|INFO|WARNING|ERROR (default: INFO in dev, WARNING in prod)

cd frontend && npm run dev  # SPA on http://localhost:5173
```

## Testing

Tests run in the real Workers runtime via `@cloudflare/vitest-pool-workers` with Miniflare. The `test/setup.ts` runs `applyD1Migrations` once per test file. All bindings (including D1) are in-memory — no Cloudflare account needed.

Run a single test by name:

```bash
npm test -- --reporter=verbose -t "test name substring"
```

## Adding new routes

1. Add the handler to `src/index.ts` behind `requireAuth` for protected routes.
2. Add any D1 queries to a file in `src/db/` (e.g. `src/db/settings.ts` for credentials/backends, `src/db/load-jobs.ts` for load jobs).
3. Add the `Env` binding in `src/types.ts` if a new binding is needed.
4. Add corresponding tests in a new `test/*.test.ts` file — use the `SELF` export from `cloudflare:test` to make real HTTP requests against the worker.

**Worker export shape:** `src/index.ts` exports `{ fetch, scheduled, queue }`. The `scheduled()` handler runs the cron dispatcher; `queue()` is the Cloudflare Queues consumer for `LOAD_JOB_QUEUE`.

## Migrations

```bash
npm run migration:new -- <migration-name>   # creates a new numbered file in migrations/
npm run migrate:local                        # applies to local D1
wrangler d1 migrations apply data-shack-db  # applies to production D1
```

The `TEST_MIGRATIONS` binding in `vitest.config.ts` is populated from the `migrations/` directory at test startup — new migration files are picked up automatically.

**Test files:**
- `test/oauth.test.ts` — OAuth flow, auth middleware
- `test/http-datasource.test.ts` — `http` credential type and `http-ds://` proxy
- `test/storage.test.ts` — Credentials and storage backends CRUD
- `test/proxy.test.ts` — S3 proxy: credential vending, GET/HEAD/PUT/LIST/OPTIONS, path enforcement, CORS, ETags
- `test/proxy-s3client.test.ts` — Functional S3 client tests using `aws4fetch` against Miniflare; exercises the full Sig V4 → proxy → R2 round-trip
- `test/catalog.test.ts` — Catalog DO: tables, snapshots, commits, transform jobs, triggers, `snapshots-latest` batch endpoint, WebSocket broadcast on commit
- `test/session.test.ts` — Session DO: WebSocket upgrade, status endpoint, MCP query relay, transform job dispatch
- `test/load-jobs.test.ts` — Load jobs CRUD, trigger endpoint, scheduler/consumer helpers
- `test/loader.test.ts` — `runHttpLoadJob` and `runGoogleSheetsLoadJob` unit tests (mocked fetch, both backend types, missing env vars, Sheets API errors)
