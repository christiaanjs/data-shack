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
npm test          # 164 vitest tests across 8 test files via @cloudflare/vitest-pool-workers
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
1. `authenticate()` in `src/auth/middleware.ts` checks for `X-Dev-Token` header first (when `ENABLE_DEV_AUTH=true`), then validates a Bearer JWT via `src/auth/jwt.ts` (HMAC-HS256).
2. All OAuth endpoints live in `src/auth/oauth.ts` via `oauthRouter`. The flow: `/authorize/:provider` → Google OAuth → `/oauth/callback` → exchange code → issue MCP auth code → redirect to client → client POSTs to `/token` → receives JWT + refresh token.
3. Provider support is Google-only. Passing any other provider to `/authorize/:provider` returns `400 invalid_request`.

**D1 query layer:** `src/db/queries.ts` for user/identity operations, `src/db/oauth.ts` for OAuth table operations, `src/db/settings.ts` for credentials/storage backends, `src/db/load-jobs.ts` for load job CRUD. All SQL is in these files — no inline SQL elsewhere.

**User identity model:** Each user is their own tenant (no household concept). `oauth_identities` maps (provider, provider_id) → user. On login, the resolution order is: existing identity → link by verified email → create new user. Email is nullable on `users` — providers that don't return a verified email still work.

**Token lifetimes:** Access tokens 1 hour (JWT), refresh tokens 30 days (stored as SHA-256 hashes in D1, rotated on every use).

**Key D1 tables:** `users`, `oauth_identities`, `oauth_states`, `oauth_clients`, `oauth_codes`, `oauth_refresh_tokens`, `credentials`, `storage_backends`, `load_jobs`. All timestamp columns are Unix milliseconds (`Date.now()`).

**Load jobs:** Cron-triggered HTTP→storage ETL jobs. The `scheduled()` handler queries D1 for due jobs and enqueues `{ jobId }` messages to `LOAD_JOB_QUEUE`. The `queue()` consumer fetches the job, runs `runHttpLoadJob` from `src/loaders/http.ts` (HTTP fetch → R2/S3 write → catalog commit), then updates `last_run_at`/`last_error`/`next_run_at` in D1. On failure, the job error is persisted and the message is retried (up to `max_retries = 3`). `POST /api/load-jobs/:id/trigger` enqueues directly for on-demand runs.

**S3-compatible storage proxy:** `POST /api/storage/proxy-credentials` (behind `requireAuth`) vends a short-lived `{ accessKeyId, secret, endpoint, region, bucket }` credential stored in `PROXY_CREDS_KV` with TTL. `GET|HEAD|PUT|OPTIONS /api/storage/s3proxy/:bucket/*key` (no `requireAuth` — the `accessKeyId` from the AWS4 `Authorization` header is the auth) forwards to the real backend: R2 binding for `r2-bound`, re-signed upstream S3 request for `r2-s3compat`. A `GET` with `?list-type=2` triggers `R2.list()` and returns S3 `ListBucketResult` XML. All responses carry CORS headers. The frontend (`frontend/src/storage.ts`) calls `acquireProxyCred()` and `buildS3Secret()` to configure DuckDB's httpfs via `CREATE OR REPLACE SECRET`.

## Frontend architecture

Single-file auth client in `frontend/src/auth.ts` — handles DCR (Dynamic Client Registration), PKCE code verifier generation, token exchange, auto-refresh (5-minute buffer), and token storage in `localStorage`/`sessionStorage`.

`frontend/src/App.tsx` is an auth state machine: `null` (loading) → `false` (login screen) → `true` (authenticated). On load it either handles the `/callback` route (token exchange) or checks for an existing access token. After authentication it calls `GET /me` to resolve `userId`.

`VITE_DEV_TOKEN` in the frontend environment skips OAuth entirely — the token is sent as `X-Dev-Token` on every request.

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
- `test/catalog.test.ts` — Catalog DO: tables, snapshots, commits
- `test/load-jobs.test.ts` — Load jobs CRUD, trigger endpoint, scheduler/consumer helpers
- `test/loader.test.ts` — `runHttpLoadJob` unit tests (mocked fetch, both backend types)
